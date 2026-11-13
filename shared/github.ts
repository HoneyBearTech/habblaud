// GitHub in the office: PR opened or merged, push, CI and release become notices and effects in the project's
// room (party or alarm). Pure code, used by the server (events detected in the transcripts, see
// server/sources/github.ts) and by the demo simulator.
import { maskSecrets, truncate, type MarkedDescription } from './activity';
import type { NoticeLevel, RoomEffect } from './types';
import { tr } from './i18n';

export type GitHubEventKind = 'pr_opened' | 'pr_merged' | 'push' | 'ci_failed' | 'ci_passed' | 'release';

/** A GitHub event seen in a transcript (or made up by the demo). */
export interface GitHubEvent {
  kind: GitHubEventKind;
  /** Number of the PR (opened, merged or whose checks ran). */
  number?: number;
  /** "owner/repo", when it appears in the URL or in the arguments. */
  repo?: string;
  /** Branch of the push or of the CI. */
  branch?: string;
  /** Tag of the release. */
  tag?: string;
  /** CI workflow or check (e.g. "CI", "build-test"). */
  workflow?: string;
  url?: string;
}

/** Marker (Activity.tool) of the activities synthesized from GitHub events. */
export const GITHUB_TOOL = 'GitHub';
/** Duration of the party (PR, merge, release). */
export const PARTY_MS = 12_000;
/** The red CI alarm ends with a green CI in the room or after this. */
export const ALARM_MS = 600_000;

const MAX_TEXT = 46;
const MAX_BANNER = 30;

function clean(s: string, max: number): string {
  return truncate(maskSecrets(s.slice(0, max * 4)), max);
}

/** Where the CI ran, for the texts: branch, PR or workflow. */
function ciWhere(ev: GitHubEvent): string | undefined {
  if (ev.branch) return clean(ev.branch, 28);
  if (ev.number !== undefined) return `PR #${ev.number}`;
  return ev.workflow ? clean(ev.workflow, 28) : undefined;
}

/** What ran, for the activity: the workflow (if it is not just "CI"), otherwise where. */
function ciWhat(ev: GitHubEvent): string | undefined {
  return ev.workflow && !/^ci$/i.test(ev.workflow.trim()) ? ev.workflow : ciWhere(ev);
}

/** Short banner of the party/alarm in the room (undefined = the event doesn't touch the room, e.g. push). */
export function bannerOf(ev: GitHubEvent): string | undefined {
  const pr = ev.number !== undefined ? `PR #${ev.number}` : 'PR';
  switch (ev.kind) {
    case 'pr_opened':
      return tr('{0} opened!', [pr]);
    case 'pr_merged':
      return tr('{0} merged!', [pr]);
    case 'release':
      return ev.tag ? clean(tr('Release {0} is live!', [ev.tag]), MAX_BANNER) : tr('Release is live!');
    case 'ci_failed': {
      const where = ciWhere(ev);
      return clean(where ? tr('CI failed ({0})', [where]) : tr('CI failed'), MAX_BANNER);
    }
    case 'ci_passed':
      return tr('CI green again!');
    default:
      return undefined;
  }
}

/** Deduplication key of the notices (the same PR/branch seen by two commands in a row). */
export function githubEventKey(ev: GitHubEvent): string {
  return `${ev.kind}:${ev.number ?? ''}:${ev.branch ?? ''}:${ev.tag ?? ''}`;
}

export interface GitHubEventText {
  /** Notice (toast). E.g. "🎉 Danilo opened PR #12 in habblaud". */
  notice: string;
  level: NoticeLevel;
  /** Agent activity (feed and timeline), with the GITHUB_TOOL marker. */
  activity: MarkedDescription;
}

/** Texts of an event: notice and activity. */
export function describeGitHubEvent(ev: GitHubEvent, agentName: string, roomName: string): GitHubEventText {
  const pr = ev.number !== undefined ? tr('PR #{0}', [ev.number]) : tr('a PR');
  const act = (icon: string, text: string, detail?: string, error = false): MarkedDescription => {
    const d: MarkedDescription = { kind: 'git', icon, text: clean(text, MAX_TEXT), tool: GITHUB_TOOL };
    const det = detail ?? ev.url ?? ev.repo;
    if (det) d.detail = clean(det, 300);
    if (error) d.error = true;
    return d;
  };
  switch (ev.kind) {
    case 'pr_opened':
      return { notice: tr('🎉 {0} opened {1} in {2}', [agentName, pr, roomName]), level: 'success', activity: act('🎉', tr('Opened {0}', [pr])) };
    case 'pr_merged':
      return { notice: tr('🎉 {0} merged {1} in {2}', [agentName, pr, roomName]), level: 'success', activity: act('🎉', tr('Merged {0}', [pr])) };
    case 'release': {
      const tag = ev.tag ? clean(ev.tag, 24) : undefined;
      return {
        notice: tr('🎉 {0} published {1} in {2}', [agentName, tag ? tr('release {0}', [tag]) : tr('a release'), roomName]),
        level: 'success',
        activity: act('🎉', tag ? tr('Published release {0}', [tag]) : tr('Published a release')),
      };
    }
    case 'push': {
      const branch = ev.branch ? clean(ev.branch, 28) : undefined;
      return {
        notice: tr('🚀 {0} pushed commits {1}in {2}', [agentName, branch ? tr('to {0} ', [branch]) : '', roomName]),
        level: 'info',
        activity: act('🚀', branch ? tr('Pushed commits to {0}', [branch]) : tr('Pushed commits to GitHub')),
      };
    }
    case 'ci_failed': {
      const where = ciWhere(ev);
      const what = ciWhat(ev);
      return {
        notice: tr('🚨 CI failed in {0}{1}', [roomName, where ? ` (${where})` : '']),
        level: 'warn',
        activity: act('🚨', what ? tr('CI failed: {0}', [what]) : tr('CI failed'), [ev.workflow, ev.branch, ev.url].filter(Boolean).join(' — ') || undefined, true),
      };
    }
    case 'ci_passed': {
      const where = ciWhere(ev);
      const what = ciWhat(ev);
      return {
        notice: tr('✅ CI passed in {0}{1}', [roomName, where ? ` (${where})` : '']),
        level: 'success',
        activity: act('✅', what ? tr('CI passed: {0}', [what]) : tr('CI passed'), [ev.workflow, ev.branch, ev.url].filter(Boolean).join(' — ') || undefined),
      };
    }
  }
}

// ------------------------------------------------------------------ room effects

interface RoomSlots {
  party?: RoomEffect;
  alarm?: RoomEffect;
}

/**
 * Life cycle of the room effects: party (PR opened/merged, release; and green CI that clears an
 * alarm) for PARTY_MS; alarm (red CI) until a green CI in the room or ALARM_MS. A party goes in
 * front of the alarm while it lasts (the alarm still holds underneath); a new red CI ends
 * the party. A room that leaves and comes back before the alarm expires comes back with it (the CI is still red).
 */
export class RoomEffects {
  private rooms = new Map<string, RoomSlots>();

  /** Applies an event to the room; true if the visible effect changed. */
  apply(roomId: string, ev: GitHubEvent, now: number, agentId?: string): boolean {
    const slots = this.rooms.get(roomId) ?? {};
    const make = (kind: RoomEffect['kind'], text: string, ms: number): RoomEffect => {
      const fx: RoomEffect = { kind, text, at: now, until: now + ms };
      if (agentId) fx.agentId = agentId;
      return fx;
    };
    switch (ev.kind) {
      case 'pr_opened':
      case 'pr_merged':
      case 'release':
        slots.party = make('party', bannerOf(ev)!, PARTY_MS);
        break;
      case 'ci_failed':
        // the newest red takes effect right away (ends a party in progress)
        slots.alarm = make('alarm', bannerOf(ev)!, ALARM_MS);
        delete slots.party;
        break;
      case 'ci_passed':
        // Green CI only changes the room if it clears an alarm (then it becomes a party).
        if (!slots.alarm || slots.alarm.until <= now) return false;
        delete slots.alarm;
        slots.party = make('party', bannerOf(ev)!, PARTY_MS);
        break;
      default:
        return false;
    }
    this.rooms.set(roomId, slots);
    return true;
  }

  /** Visible effect of the room now (the party in front of the alarm), or undefined. */
  get(roomId: string, now: number): RoomEffect | undefined {
    const slots = this.rooms.get(roomId);
    if (!slots) return undefined;
    if (slots.party && slots.party.until > now) return slots.party;
    if (slots.alarm && slots.alarm.until > now) return slots.alarm;
    return undefined;
  }

  /** Forgets the expired effects; true if any left (the snapshot has to be rebuilt). */
  prune(now: number): boolean {
    let changed = false;
    for (const [id, slots] of this.rooms) {
      if (slots.party && slots.party.until <= now) {
        delete slots.party;
        changed = true;
      }
      if (slots.alarm && slots.alarm.until <= now) {
        delete slots.alarm;
        changed = true;
      }
      if (!slots.party && !slots.alarm) this.rooms.delete(id);
    }
    return changed;
  }
}
