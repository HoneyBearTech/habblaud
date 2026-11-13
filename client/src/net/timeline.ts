// Timelapse in the browser: fetches the timeline recorded by the server (GET /api/timeline/*) and
// rebuilds the office at any instant of the day (format in shared/timeline.ts). The rebuild
// starts from the previous keyframe and applies the deltas up to the instant; moving forward, it only applies what
// is missing. It also summarizes the day (agents present and working per minute) for the chart and the peaks.
import type { Activity, OfficeSnapshot } from '../../../shared/types';
import {
  applyChanges,
  emptyFrame,
  frameOf,
  isDayKey,
  parseTimeline,
  toAccountInfo,
  toActivity,
  toAgentInfo,
  toRoomInfo,
  type TimelineAgent,
  type TimelineFrame,
  type TimelineRecord,
} from '../../../shared/timeline';
import { tr } from '../../../shared/i18n';

export interface TimelineDayInfo {
  /** YYYY-MM-DD. */
  day: string;
  bytes: number;
  /** First and last record of the day (epoch ms). */
  from: number;
  to: number;
}

export interface TimelineDays {
  /** The server is recording (HABBLAUD_TIMELINE did not turn it off). */
  recording: boolean;
  days: TimelineDayInfo[];
}

export async function fetchTimelineDays(signal?: AbortSignal): Promise<TimelineDays> {
  const res = await fetch('/api/timeline/days', { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Partial<TimelineDays>;
  const days = Array.isArray(body.days) ? body.days.filter((d) => isDayKey(d?.day) && Number.isFinite(d.from) && Number.isFinite(d.to)) : [];
  return { recording: body.recording === true, days };
}

export async function fetchTimelineDay(day: string, signal?: AbortSignal): Promise<TimelineRecord[]> {
  if (!isDayKey(day)) throw new Error(tr('invalid day'));
  const res = await fetch(`/api/timeline/${day}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseTimeline(await res.text());
}

/** One minute of the timeline: the maximum of agents present, working and waiting for you. */
export interface TimelineBucket {
  at: number;
  present: number;
  working: number;
  waiting: number;
}

export interface TimelinePeak {
  at: number;
  working: number;
  present: number;
}

export const BUCKET_MS = 60_000;
/** Recent activities of each agent in the rebuilt snapshot (like the server's SNAPSHOT_RECENT). */
const RECENT = 8;
/** Slack over ~1.5 keyframe interval with no record at all: from then on, "no data". */
const GAP_SLACK_MS = 60_000;
const PEAKS = 4;
/** Minimum distance between two peaks: 1/8 of the recorded period, between 10 min and 1 h. */
const peakSpacing = (span: number) => Math.min(60 * 60_000, Math.max(10 * 60_000, span / 8));

export interface ReplayView {
  /** Show the demo mode agents. */
  includeDemo: boolean;
}

const visible = (demo: boolean | undefined, view: ReplayView) => view.includeDemo || !demo;

export class TimelineReplay {
  readonly from: number;
  readonly to: number;
  readonly hasDemo: boolean;
  readonly hasReal: boolean;
  /** Indexes of the keyframes in `records`. */
  private readonly keys: number[] = [];
  private frame: TimelineFrame = emptyFrame();
  /** Last record applied (-1 = before the first). */
  private cursor = -1;
  /** Keyframe interval in effect at the current point. */
  private every = 300_000;
  private recent = new Map<string, Activity[]>();
  private rev = 0;
  private readonly createdAt = Date.now();
  private bucketCache = new Map<boolean, TimelineBucket[]>();

  constructor(
    readonly day: string,
    readonly records: TimelineRecord[],
  ) {
    let demo = false;
    let real = false;
    records.forEach((r, i) => {
      if (r.t === 'k') {
        this.keys.push(i);
        for (const a of r.agents) a.demo ? (demo = true) : (real = true);
      } else if (r.t === 'd') {
        for (const [, p] of r.agents ?? []) if (p && typeof p.id === 'string') p.demo ? (demo = true) : (real = true);
      }
    });
    this.hasDemo = demo;
    this.hasReal = real;
    this.from = records[0]?.at ?? 0;
    this.to = records[records.length - 1]?.at ?? this.from;
  }

  get empty(): boolean {
    return this.records.length === 0;
  }

  /** Takes the rebuild to instant `t` (backward or far away: starts over from the previous keyframe). */
  moveTo(t: number): void {
    const target = this.indexAt(t);
    if (target === this.cursor) return;
    if (target < 0) {
      this.frame = emptyFrame();
      this.recent.clear();
      this.cursor = -1;
      return;
    }
    let start: number;
    if (target < this.cursor || this.cursor < 0) {
      // Backward (or from scratch): starts over from the previous keyframe, with no activities "from the future" in the recent.
      start = this.keyAtOrBefore(target);
      this.recent.clear();
      if (start < 0) {
        this.frame = emptyFrame();
        start = 0;
      }
    } else {
      // Forward: if there is a keyframe on the way, jumps straight to it.
      start = this.cursor + 1;
      const k = this.keyAtOrBefore(target);
      if (k > this.cursor) start = k;
    }
    for (let i = start; i <= target; i++) this.apply(i);
    this.cursor = target;
  }

  /** No data at `t`: before the recording, server stopped (end marked) or a silence that is too long. */
  isOff(t: number): boolean {
    if (this.cursor < 0) return true;
    const last = this.records[this.cursor];
    if (last.t === 'end') return true;
    return t - last.at > this.every * 1.5 + GAP_SLACK_MS;
  }

  /** The most recent marked end was due to the day's size limit. */
  get limited(): boolean {
    const last = this.records[this.cursor];
    return last?.t === 'end' && last.reason === 'limit';
  }

  /** Snapshot of instant `t` (call moveTo(t) first), as if it came from the server. */
  snapshot(t: number, view: ReplayView): OfficeSnapshot {
    const off = this.isOff(t);
    const agents = off
      ? []
      : [...this.frame.agents.values()].filter((a) => visible(a.demo, view)).map((a) => toAgentInfo(a, this.recent.get(a.id) ?? []));
    const rooms = off ? [] : [...this.frame.rooms.values()].filter((r) => visible(r.demo, view)).map(toRoomInfo);
    const accounts = [...this.frame.accounts.values()].filter((a) => visible(a.demo, view)).map((a) => toAccountInfo(a, t));
    return {
      rev: ++this.rev,
      serverTime: t,
      rooms: rooms.sort((a, b) => a.slot - b.slot),
      agents,
      accounts,
      meta: {
        demo: agents.some((a) => this.frame.agents.get(a.id)?.demo),
        sources: [],
        startedAt: this.createdAt,
        version: 'timelapse',
        // No terminal in the replay: the conversation is from the present, not from the instant being played.
        terminal: false,
      },
    };
  }

  /** Agents present, working and waiting, minute by minute (for the timeline chart). */
  buckets(view: ReplayView): TimelineBucket[] {
    const hit = this.bucketCache.get(view.includeDemo);
    if (hit) return hit;
    const out: TimelineBucket[] = [];
    if (this.empty) return out;
    const base = Math.floor(this.from / BUCKET_MS) * BUCKET_MS;
    const n = Math.min(2 * 1441, Math.floor((this.to - base) / BUCKET_MS) + 1);
    for (let i = 0; i < n; i++) out.push({ at: base + i * BUCKET_MS, present: 0, working: 0, waiting: 0 });
    const frame = emptyFrame();
    let every = 300_000;
    let ended = false;
    let counts = { present: 0, working: 0, waiting: 0 };
    let lastAt = this.from;
    const fill = (fromAt: number, toAt: number, c: typeof counts) => {
      // From the previous record to this one, the state did not change (except for a long silence = server stopped).
      const until = ended ? fromAt : Math.min(toAt, fromAt + every * 1.5 + GAP_SLACK_MS);
      for (let i = Math.max(0, Math.floor((fromAt - base) / BUCKET_MS)); i < n && base + i * BUCKET_MS <= until; i++) {
        const b = out[i];
        b.present = Math.max(b.present, c.present);
        b.working = Math.max(b.working, c.working);
        b.waiting = Math.max(b.waiting, c.waiting);
      }
    };
    for (const r of this.records) {
      fill(lastAt, r.at, counts);
      if (r.t === 'k') {
        const f = frameOf(r);
        frame.agents = f.agents;
        frame.rooms = f.rooms;
        frame.accounts = f.accounts;
        every = r.every;
        ended = false;
      } else if (r.t === 'd') {
        applyChanges(frame, r);
        ended = false;
      } else ended = true;
      counts = ended ? { present: 0, working: 0, waiting: 0 } : count(frame, view);
      lastAt = r.at;
      fill(r.at, r.at, counts);
    }
    this.bucketCache.set(view.includeDemo, out);
    return out;
  }

  /** Peak moments (the most agents working at the same time), spaced out, in chronological order. */
  peaks(view: ReplayView): TimelinePeak[] {
    const ranked = this.buckets(view)
      .filter((b) => b.working > 0)
      .sort((a, b) => b.working - a.working || b.present - a.present || a.at - b.at);
    const out: TimelinePeak[] = [];
    const spacing = peakSpacing(this.to - this.from);
    for (const b of ranked) {
      if (out.length >= PEAKS) break;
      if (out.some((p) => Math.abs(p.at - b.at) < spacing)) continue;
      out.push({ at: b.at, working: b.working, present: b.present });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // ---------------------------------------------------------------- internals

  private apply(i: number): void {
    const r = this.records[i];
    if (r.t === 'k') {
      this.frame = frameOf(r);
      this.every = r.every;
      for (const id of [...this.recent.keys()]) if (!this.frame.agents.has(id)) this.recent.delete(id);
      for (const a of r.agents) this.remember(a);
    } else if (r.t === 'd') {
      applyChanges(this.frame, r);
      for (const [id, p] of r.agents ?? []) {
        if (!p) this.recent.delete(id);
        else if (p.activity) {
          const a = this.frame.agents.get(id);
          if (a) this.remember(a);
        }
      }
    }
  }

  /** Accumulates the current activity in the agent's `recent` (without repeating the last one). */
  private remember(a: TimelineAgent): void {
    if (!a.activity) return;
    const act = toActivity(a.id, a.activity);
    const list = this.recent.get(a.id) ?? [];
    if (list[list.length - 1]?.id === act.id) return;
    list.push(act);
    if (list.length > RECENT) list.splice(0, list.length - RECENT);
    this.recent.set(a.id, list);
  }

  /** Last record with `at` <= t (-1 = before the first). The records are in order of `at`. */
  private indexAt(t: number): number {
    let lo = 0;
    let hi = this.records.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.records[mid].at <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Index of the last keyframe at or before record `i` (-1 = none). */
  private keyAtOrBefore(i: number): number {
    let ans = -1;
    for (const k of this.keys) {
      if (k > i) break;
      ans = k;
    }
    return ans;
  }
}

function count(frame: TimelineFrame, view: ReplayView): { present: number; working: number; waiting: number } {
  let present = 0;
  let working = 0;
  let waiting = 0;
  for (const a of frame.agents.values()) {
    if (!visible(a.demo, view) || a.status === 'offline' || a.status === 'done') continue;
    present++;
    if (a.status === 'working') working++;
    else if (a.status === 'waiting') waiting++;
  }
  return { present, working, waiting };
}
