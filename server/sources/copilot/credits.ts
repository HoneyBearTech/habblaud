// AI credits of each Copilot account, counted from the session files on this computer (session-state/<session>/
// events.jsonl, the same checked paths as files.ts). Only `session.usage_checkpoint` and `session.shutdown` count:
// their `data.totalNanoAiu` is the session's RUNNING total, in billionths of a unit (1 unit = 1 AI credit, see
// NANO_AIU_PER_CREDIT). `session.usage_record` (premium requests: `cost`, `initiator`) is never used here.
//
// Rules, per session (one events file):
// - each rise of the running total is counted at that event's top-level `timestamp`, in its UTC day; a checkpoint and
//   the shutdown that follows it usually carry the same total, which adds nothing;
// - a total that goes down starts the session's baseline again (nothing is counted for it: no double counting);
// - a file that shrinks or is replaced is counted again from the start, and its old contribution is dropped;
// - events without a finite, non-negative totalNanoAiu or without a valid timestamp are ignored, and so are broken
//   lines (lines over MAX_LINE_BYTES are skipped by FileTail, like everywhere else).
// Only what can matter is kept: the per-day sums of the current UTC month. A file last changed before this month is not
// read (it can't hold this month's events); when it changes again it is read from the start, so its running total has
// the right baseline. Each file is read once and then only its new bytes (cached by size and mtime), with a byte budget
// per call so a first pass over large files never blocks the server for long.
import { FileTail } from '../tail';

/** Billionths of a unit per AI credit (`totalNanoAiu` → credits). 1 unit is taken as 1 AI credit. */
export const NANO_AIU_PER_CREDIT = 1_000_000_000;
/** Event types that carry the running total. */
const TOTAL_EVENTS = new Set(['session.usage_checkpoint', 'session.shutdown']);
/** Bytes read from all the files in one call (update or pump); the rest waits for the next call. */
export const READ_BUDGET_BYTES = 16 * 1024 * 1024;
/** Bytes read from a file in one go. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const DAY_MS = 86_400_000;

/** 00:00 UTC of the 1st of the month of `at`. */
export function utcMonthStart(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** 00:00 UTC of the 1st of the month after the one of `at` (when the monthly count starts again). */
export function utcNextMonthStart(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** 00:00 UTC of the day of `at`. */
export function utcDayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/** A running total read from one events line: when (epoch ms) and how much (billionths of a unit). */
export interface CreditReading {
  at: number;
  nano: number;
}

/** The running total of one line, or undefined (another event, a broken line, an invalid total or timestamp). */
export function parseCreditLine(line: string): CreditReading | undefined {
  // Cheap filter first: most lines are other events.
  if (!line.includes('totalNanoAiu')) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;
  const r = j as Record<string, unknown>;
  if (typeof r.type !== 'string' || !TOTAL_EVENTS.has(r.type)) return undefined;
  const data = r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : undefined;
  const nano = data?.totalNanoAiu;
  if (typeof nano !== 'number' || !Number.isFinite(nano) || nano < 0) return undefined;
  const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  if (!Number.isFinite(at)) return undefined;
  return { at, nano };
}

/** One session file in the listing of an account (what the rescan already stat-ed). */
export interface CreditFileStat {
  sessionId: string;
  /** Checked path (sessionFile). */
  path: string;
  size: number;
  mtimeMs: number;
}

/** What an account used: credits this UTC month and today, and whether any event of this month had a total. */
export interface CreditTotals {
  month: number;
  today: number;
  hasData: boolean;
}

interface FileCount {
  account: string;
  tail: FileTail;
  /** Last running total of the session (billionths): the baseline of the next rise. */
  last?: number;
  /** Rises this month by UTC day (00:00 UTC → billionths). A 0 entry = an event of this month with no rise. */
  days: Map<number, number>;
  /** size and mtime at the last read (the cache key). */
  size: number;
  mtimeMs: number;
  /** Bytes still to read (the budget ran out). */
  pending: boolean;
}

export class CopilotCredits {
  /** account + session → count. */
  private files = new Map<string, FileCount>();
  /** Accounts listed at least once by update(). */
  private listed = new Set<string>();
  private budget = 0;
  private readonly budgetBytes: number;
  private readonly chunkBytes: number;

  constructor(opts: { budgetBytes?: number; chunkBytes?: number } = {}) {
    this.budgetBytes = opts.budgetBytes ?? READ_BUDGET_BYTES;
    this.chunkBytes = opts.chunkBytes ?? READ_CHUNK_BYTES;
  }

  /**
   * The rescan of an account: every session file it found (stat-ed). Reads what is new (within the budget), forgets
   * the files that are gone or that can no longer matter (last changed before this month).
   */
  update(account: string, list: readonly CreditFileStat[], now: number): void {
    this.listed.add(account);
    this.budget = this.budgetBytes;
    const monthStart = utcMonthStart(now);
    const keep = new Set<string>();
    for (const s of list) {
      if (s.mtimeMs < monthStart) continue;
      const key = `${account}:${s.sessionId}`;
      keep.add(key);
      let f = this.files.get(key);
      if (f && f.tail.path !== s.path) f = undefined;
      if (!f) {
        f = { account, tail: new FileTail(s.path, { maxChunk: this.chunkBytes }), days: new Map(), size: -1, mtimeMs: -1, pending: true };
        this.files.set(key, f);
      } else if (s.size !== f.size || s.mtimeMs !== f.mtimeMs) f.pending = true;
      if (f.pending && this.budget > 0) this.read(key, f, monthStart);
    }
    for (const [key, f] of this.files) if (f.account === account && !keep.has(key)) this.files.delete(key);
  }

  /** Is any file still to be read to the end? */
  hasPending(): boolean {
    for (const f of this.files.values()) if (f.pending) return true;
    return false;
  }

  /** Goes on reading the files the budget left halfway (each poll). */
  pump(now: number): void {
    this.budget = this.budgetBytes;
    const monthStart = utcMonthStart(now);
    for (const [key, f] of this.files) {
      if (this.budget <= 0) break;
      if (f.pending) this.read(key, f, monthStart);
    }
  }

  /** Has every file of the account been read to the end at least once? (Before that, the sum would be too low.) */
  ready(account: string): boolean {
    if (!this.listed.has(account)) return false;
    for (const f of this.files.values()) if (f.account === account && f.pending) return false;
    return true;
  }

  /** Credits of the account this UTC month and today. Drops the days of earlier months (month rollover). */
  totals(account: string, now: number): CreditTotals {
    const monthStart = utcMonthStart(now);
    const nextMonth = utcNextMonthStart(now);
    const today = utcDayStart(now);
    let month = 0;
    let day = 0;
    let hasData = false;
    for (const f of this.files.values()) {
      if (f.account !== account) continue;
      for (const [d, nano] of f.days) {
        if (d < monthStart) {
          f.days.delete(d);
          continue;
        }
        if (d >= nextMonth) continue;
        hasData = true;
        month += nano;
        if (d === today) day += nano;
      }
    }
    return { month: toCredits(month), today: toCredits(day), hasData };
  }

  private read(key: string, f: FileCount, monthStart: number): void {
    for (;;) {
      const before = f.tail.offset;
      let r;
      try {
        r = f.tail.read();
      } catch {
        // unreadable now (permissions, a race with a rewrite): tried again on the next change
        f.pending = false;
        return;
      }
      if (r.missing) {
        this.files.delete(key);
        return;
      }
      if (r.reset) {
        // Rewritten or shrunk: this session is counted again from the start.
        delete f.last;
        f.days.clear();
      }
      for (const line of r.lines) this.apply(f, line, monthStart);
      f.size = f.tail.size;
      f.mtimeMs = f.tail.mtimeMs;
      this.budget -= Math.max(0, f.tail.offset - (r.reset ? 0 : before));
      if (!r.more) {
        f.pending = false;
        return;
      }
      if (this.budget <= 0) {
        f.pending = true;
        return;
      }
    }
  }

  private apply(f: FileCount, line: string, monthStart: number): void {
    const r = parseCreditLine(line);
    if (!r) return;
    const rise = r.nano - (f.last ?? 0);
    // A total that goes down is the new baseline: nothing is counted for it.
    f.last = r.nano;
    if (r.at < monthStart) return;
    const day = utcDayStart(r.at);
    f.days.set(day, (f.days.get(day) ?? 0) + Math.max(0, rise));
  }
}

/** Billionths → credits, rounded to a thousandth (stable numbers in the snapshot). */
export function toCredits(nano: number): number {
  return Math.round((nano / NANO_AIU_PER_CREDIT) * 1000) / 1000;
}
