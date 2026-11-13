// Timeline of the office (timelapse): format of the files written by the server
// (server/history/timeline.ts) and rebuilding of the state, used by the client's player.
// Pure code: no Node or DOM APIs.
//
// File: <dataDir>/timeline/AAAA-MM-DD.jsonl (server's local day), one JSON record per line:
//   {"t":"k",...}    keyframe: the complete state (rooms, agents and accounts);
//   {"t":"d",...}    delta: only what changed since the previous record;
//   {"t":"end",...}  the server stopped (or the day reached the size limit).
// Every file starts with a keyframe and the keyframes repeat every `every` ms; with no record
// for much longer than that, the server was off. Each record starts with `t` and `at` (in that order),
// which makes it possible to read the time of the first and the last line without parsing the whole file.
//
// Only the fields that the world and the interface use to draw go in, with the activity summaries already
// masked (the same exposure as /api/snapshot): no command, task or transcript detail.
import type { AppearanceParts } from './appearance';
import type { AccountInfo, AccountUsage, Activity, ActivityKind, AgentInfo, AgentKind, AgentStatus, OfficeSnapshot, Provider, RoomInfo, ShellJob } from './types';

export const TIMELINE_VERSION = 1;

/** Long titles and texts are cut (the day's file has a size limit). */
const MAX_TITLE = 160;
const MAX_TEXT = 120;

export interface TimelineActivity {
  kind: ActivityKind;
  icon: string;
  text: string;
  at: number;
  tool?: string;
  error?: true;
}

/** Summarized shell (without the full command). */
export interface TimelineShell {
  id: string;
  label: string;
  startedAt: number;
  background: boolean;
  kind: 'shell' | 'monitor';
}

export interface TimelineAgent {
  id: string;
  kind: AgentKind;
  /** Absent = 'claude' (AgentInfo.provider). */
  provider?: Provider;
  parentId?: string;
  roomId: string;
  name: string;
  look: 'f' | 'm';
  role: string;
  account: string;
  status: AgentStatus;
  statusSince: number;
  startedAt: number;
  waitingFor?: string;
  activity?: TimelineActivity;
  seed: number;
  /** Parts of the edited character (see AgentInfo.parts). */
  parts?: AppearanceParts;
  background?: true;
  title?: string;
  shells?: TimelineShell[];
  /** Demo mode agent (id with the "demo:" prefix): the player can hide it. */
  demo?: true;
}

export interface TimelineRoom {
  id: string;
  name: string;
  path: string;
  slot: number;
  seed: number;
  createdAt: number;
  demo?: true;
}

/** Summarized account: no email, organization or folder; usage without the collection time (it would change with every response). */
export interface TimelineAccount {
  id: string;
  /** Absent = 'claude' (AccountInfo.provider). */
  provider?: Provider;
  short: string;
  name: string;
  color: string;
  plan?: string;
  sessions: number;
  usage?: Pick<AccountUsage, 'fiveHour' | 'sevenDay' | 'source' | 'noQuota'>;
  usageStatus: AccountInfo['usageStatus'];
  demo?: true;
}

export interface TimelineKeyframe {
  t: 'k';
  at: number;
  v: number;
  /** Interval between keyframes in effect (ms). */
  every: number;
  /** First record after the server comes up. */
  boot?: true;
  rooms: TimelineRoom[];
  agents: TimelineAgent[];
  accounts: TimelineAccount[];
}

/** Fields that changed; `null` = the field no longer exists. */
export type TimelinePatch<T> = { [K in keyof T]?: T[K] | null };

/** What changed between two states. A new agent comes complete; `null` = left. */
export interface TimelineChanges {
  rooms?: [string, TimelineRoom | null][];
  agents?: [string, TimelinePatch<TimelineAgent> | null][];
  accounts?: [string, TimelineAccount | null][];
}

export interface TimelineDelta extends TimelineChanges {
  t: 'd';
  at: number;
}

export interface TimelineEnd {
  t: 'end';
  at: number;
  /** 'limit' = the day reached the size limit and the recording stopped until the day rolls over. */
  reason?: 'stop' | 'limit';
}

export type TimelineRecord = TimelineKeyframe | TimelineDelta | TimelineEnd;

/** Complete state at an instant (what a keyframe describes). */
export interface TimelineFrame {
  rooms: Map<string, TimelineRoom>;
  agents: Map<string, TimelineAgent>;
  accounts: Map<string, TimelineAccount>;
}

// ------------------------------------------------------------------ days

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local day of an instant, in the format of the file name (YYYY-MM-DD). */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** YYYY-MM-DD of a date that exists on the calendar (it is the only format accepted as a file name). */
export function isDayKey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Local midnight of the day `key` (epoch ms). */
export function dayStart(key: string): number {
  const [y, mo, d] = key.split('-').map(Number);
  return new Date(y, mo - 1, d).getTime();
}

/** The day `offset` days before/after `key` (calendar arithmetic: immune to daylight saving time). */
export function shiftDay(key: string, offset: number): string {
  const [y, mo, d] = key.split('-').map(Number);
  return dayKey(new Date(y, mo - 1, d + offset, 12).getTime());
}

// ------------------------------------------------------------------ snapshot -> record

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function compactActivity(a: Activity): TimelineActivity {
  const out: TimelineActivity = { kind: a.kind, icon: a.icon, text: clip(a.text, MAX_TEXT), at: a.at };
  if (a.tool) out.tool = a.tool;
  if (a.error) out.error = true;
  return out;
}

export function compactShell(j: ShellJob): TimelineShell {
  return { id: j.id, label: clip(j.label, MAX_TEXT), startedAt: j.startedAt, background: j.background, kind: j.kind };
}

export function compactAgent(a: AgentInfo, demo = false): TimelineAgent {
  const out: TimelineAgent = {
    id: a.id,
    kind: a.kind,
    roomId: a.roomId,
    name: a.name,
    look: a.look,
    role: a.role,
    account: a.account,
    status: a.status,
    statusSince: a.statusSince,
    startedAt: a.startedAt,
    seed: a.seed,
  };
  if (a.provider) out.provider = a.provider;
  if (a.parentId) out.parentId = a.parentId;
  if (a.waitingFor) out.waitingFor = a.waitingFor;
  if (a.activity) out.activity = compactActivity(a.activity);
  if (a.background) out.background = true;
  if (a.parts && Object.keys(a.parts).length) out.parts = { ...a.parts };
  if (a.title) out.title = clip(a.title, MAX_TITLE);
  if (a.shells?.length) out.shells = a.shells.map(compactShell);
  if (demo) out.demo = true;
  return out;
}

export function compactRoom(r: RoomInfo, demo = false): TimelineRoom {
  const out: TimelineRoom = { id: r.id, name: r.name, path: r.path, slot: r.slot, seed: r.seed, createdAt: r.createdAt };
  if (demo) out.demo = true;
  return out;
}

export function compactAccount(a: AccountInfo, demo = false): TimelineAccount {
  const out: TimelineAccount = { id: a.id, short: a.short, name: a.name, color: a.color, sessions: a.sessions, usageStatus: a.usageStatus };
  if (a.provider) out.provider = a.provider;
  if (a.plan) out.plan = a.plan;
  if (a.usage) {
    const u: NonNullable<TimelineAccount['usage']> = { source: a.usage.source };
    if (a.usage.fiveHour) u.fiveHour = { ...a.usage.fiveHour };
    if (a.usage.sevenDay) u.sevenDay = { ...a.usage.sevenDay };
    if (a.usage.noQuota) u.noQuota = true;
    out.usage = u;
  }
  if (demo) out.demo = true;
  return out;
}

/** Demo mode agents, rooms and accounts use the "demo:" prefix (see Office.setDemo). */
export const isDemoId = (id: string): boolean => id.startsWith('demo:');

export function compactSnapshot(snap: OfficeSnapshot, isDemo: (id: string) => boolean = isDemoId): TimelineFrame {
  return {
    rooms: new Map(snap.rooms.map((r) => [r.id, compactRoom(r, isDemo(r.id))])),
    agents: new Map(snap.agents.map((a) => [a.id, compactAgent(a, isDemo(a.id))])),
    accounts: new Map(snap.accounts.map((a) => [a.id, compactAccount(a, isDemo(a.id))])),
  };
}

export function keyframeOf(frame: TimelineFrame, at: number, every: number, boot = false): TimelineKeyframe {
  const k: TimelineKeyframe = {
    t: 'k',
    at,
    v: TIMELINE_VERSION,
    every,
    rooms: [...frame.rooms.values()],
    agents: [...frame.agents.values()],
    accounts: [...frame.accounts.values()],
  };
  if (boot) k.boot = true;
  return k;
}

export function frameOf(k: TimelineKeyframe): TimelineFrame {
  return {
    rooms: new Map(k.rooms.map((r) => [r.id, r])),
    agents: new Map(k.agents.map((a) => [a.id, a])),
    accounts: new Map(k.accounts.map((a) => [a.id, a])),
  };
}

export function emptyFrame(): TimelineFrame {
  return { rooms: new Map(), agents: new Map(), accounts: new Map() };
}

// ------------------------------------------------------------------ differences

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function patchOf<T extends object>(prev: T, next: T): TimelinePatch<T> | null {
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  let patch: Record<string, unknown> | null = null;
  for (const k of Object.keys(n)) if (!same(p[k], n[k])) (patch ??= {})[k] = n[k];
  for (const k of Object.keys(p)) if (!(k in n)) (patch ??= {})[k] = null;
  return patch as TimelinePatch<T> | null;
}

function diffWhole<T>(prev: Map<string, T>, next: Map<string, T>): [string, T | null][] {
  const out: [string, T | null][] = [];
  for (const [id, v] of next) if (!same(prev.get(id), v)) out.push([id, v]);
  for (const id of prev.keys()) if (!next.has(id)) out.push([id, null]);
  return out;
}

/** What changed from `prev` to `next` (null = nothing the player draws). */
export function diffFrames(prev: TimelineFrame, next: TimelineFrame): TimelineChanges | null {
  const out: TimelineChanges = {};
  const rooms = diffWhole(prev.rooms, next.rooms);
  if (rooms.length) out.rooms = rooms;
  const agents: [string, TimelinePatch<TimelineAgent> | null][] = [];
  for (const [id, a] of next.agents) {
    const p = prev.agents.get(id);
    if (!p) agents.push([id, a]);
    else {
      const patch = patchOf(p, a);
      if (patch) agents.push([id, patch]);
    }
  }
  for (const id of prev.agents.keys()) if (!next.agents.has(id)) agents.push([id, null]);
  if (agents.length) out.agents = agents;
  const accounts = diffWhole(prev.accounts, next.accounts);
  if (accounts.length) out.accounts = accounts;
  return out.rooms || out.agents || out.accounts ? out : null;
}

const isFullAgent = (p: TimelinePatch<TimelineAgent>): p is TimelineAgent =>
  typeof p.id === 'string' && typeof p.roomId === 'string' && typeof p.name === 'string' && typeof p.status === 'string' && typeof p.seed === 'number';

/**
 * Applies the changes (without changing the old objects: changed agents become new objects, so
 * snapshots already delivered to the interface still hold). A patch of an unknown agent that doesn't come
 * complete (line lost in the file) is ignored: the next keyframe fixes it.
 */
export function applyChanges(frame: TimelineFrame, d: TimelineChanges): void {
  for (const [id, r] of d.rooms ?? []) {
    if (r) frame.rooms.set(id, r);
    else frame.rooms.delete(id);
  }
  for (const [id, acc] of d.accounts ?? []) {
    if (acc) frame.accounts.set(id, acc);
    else frame.accounts.delete(id);
  }
  for (const [id, patch] of d.agents ?? []) {
    if (!patch) {
      frame.agents.delete(id);
      continue;
    }
    const cur = frame.agents.get(id);
    if (!cur) {
      if (isFullAgent(patch)) frame.agents.set(id, withoutNulls(patch) as TimelineAgent);
      continue;
    }
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    frame.agents.set(id, next as unknown as TimelineAgent);
  }
}

function withoutNulls<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null) out[k] = v;
  return out as T;
}

// ------------------------------------------------------------------ reading

/**
 * Parses the content of a day's file. Invalid lines (cut, corrupted) are ignored;
 * a clock that went back in time doesn't put the records out of order (the time is held at the previous one).
 */
export function parseTimeline(text: string): TimelineRecord[] {
  const out: TimelineRecord[] = [];
  let last = -Infinity;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(rec)) continue;
    if (rec.at < last) rec.at = last;
    last = rec.at;
    out.push(rec);
  }
  return out;
}

function isRecord(r: unknown): r is TimelineRecord {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return false;
  if (o.t === 'k') return Array.isArray(o.rooms) && Array.isArray(o.agents) && Array.isArray(o.accounts) && typeof o.every === 'number';
  if (o.t === 'd') return ['rooms', 'agents', 'accounts'].every((k) => o[k] === undefined || Array.isArray(o[k]));
  return o.t === 'end';
}

// ------------------------------------------------------------------ record -> snapshot

const ZERO_STATS = { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };

/** Stable id of a rebuilt activity (the file doesn't keep the original id). */
export function activityId(agentId: string, a: Pick<TimelineActivity, 'at' | 'kind'>): string {
  return `tl:${agentId}:${a.at}:${a.kind}`;
}

export function toActivity(agentId: string, a: TimelineActivity): Activity {
  const out: Activity = { id: activityId(agentId, a), kind: a.kind, icon: a.icon, text: a.text, at: a.at };
  if (a.tool) out.tool = a.tool;
  if (a.error) out.error = true;
  return out;
}

/** Complete AgentInfo from the recorded summary (fields the file doesn't keep stay empty). */
export function toAgentInfo(t: TimelineAgent, recent: Activity[] = []): AgentInfo {
  const activity = t.activity ? toActivity(t.id, t.activity) : undefined;
  const a: AgentInfo = {
    id: t.id,
    kind: t.kind,
    roomId: t.roomId,
    name: t.name,
    look: t.look,
    role: t.role,
    sessionId: t.id,
    account: t.account,
    status: t.status,
    recent: recent.length ? recent.slice() : activity ? [activity] : [],
    tasks: [],
    startedAt: t.startedAt,
    lastEventAt: Math.max(t.statusSince, activity?.at ?? 0),
    statusSince: t.statusSince,
    stats: { ...ZERO_STATS },
    seed: t.seed,
  };
  if (t.provider) a.provider = t.provider;
  if (t.parentId) a.parentId = t.parentId;
  if (t.title) a.title = t.title;
  if (t.waitingFor) a.waitingFor = t.waitingFor;
  if (activity) a.activity = activity;
  if (t.shells?.length) a.shells = t.shells.map((j) => ({ ...j }));
  if (t.background) a.background = true;
  if (t.parts) a.parts = { ...t.parts };
  return a;
}

export function toRoomInfo(r: TimelineRoom): RoomInfo {
  return { id: r.id, name: r.name, path: r.path, slot: r.slot, seed: r.seed, createdAt: r.createdAt };
}

export function toAccountInfo(a: TimelineAccount, at: number): AccountInfo {
  const out: AccountInfo = { id: a.id, short: a.short, name: a.name, color: a.color, configDir: '', sessions: a.sessions, usageStatus: a.usageStatus };
  if (a.provider) out.provider = a.provider;
  if (a.plan) out.plan = a.plan;
  if (a.usage) {
    const u: AccountUsage = { source: a.usage.source, fetchedAt: at };
    if (a.usage.fiveHour) u.fiveHour = { ...a.usage.fiveHour };
    if (a.usage.sevenDay) u.sevenDay = { ...a.usage.sevenDay };
    if (a.usage.noQuota) u.noQuota = true;
    out.usage = u;
  }
  return out;
}
