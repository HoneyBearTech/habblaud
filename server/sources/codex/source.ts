// Codex agent source (AgentSource 'codex', see sources/source.ts): the `codex` CLI and the desktop app, which write
// to the same CODEX_HOME. Watches the OPEN sessions of each Codex account and feeds the Office; the hook events
// (CodexLive, via POST /api/codex/events) arrive through applyHookEvent and bring forward what the files don't tell
// yet.
//
// Presence (Codex doesn't write a session record like the Claude Code one):
// - a loaded thread has the file `thread-writer-locks/<thread>.lock`, checked only for EXISTENCE (polling;
//   never flock). The lock needs to be a few seconds old (LOCK_SETTLE_MS, by the age of the file): maintenance
//   operations (archive, rename, migrate, compress) create quick locks that are not sessions;
// - the thread's rollout (found by the id in the file name) gives the project (cwd of the session_meta), the title
//   and what the agent does. Lock without rollout = session open and still empty: Codex only creates the file (and
//   the SessionStart hook only fires) on the first prompt, and the lock doesn't tell the folder. Without the project
//   there is no room: the main agent only comes in when the rollout or a hook tells the cwd (a newly opened CLI
//   shows up with the first message);
// - no lock = closed (with the same 1.5 s margin as Claude Code). Old lock from a crash (Codex only cleans it up the
//   next time it opens): lock created more than STALE_LOCK_MS ago, rollout idle for more than STALE_LOCK_MS (or no
//   rollout) and no hook event = closed. A new write to the rollout (or a hook) reopens it. Known limit:
//   a session open and forgotten for more than 12 h with nothing new also leaves (it comes back at the first sign
//   of life);
// - version without `thread-writer-locks/` (or Docker without the folder mounted): rollout modified in the last
//   30 min;
// - a hook event keeps the agent present for HOOK_PRESENCE_MS even with no visible lock; SessionEnd closes (if the
//   lock is gone too, or after SESSION_END_GRACE_MS).
// Subagents (spawn_agent) are threads of their own, with lock and rollout: the session_meta points to the parent.
// They come in as subagents of the parent while they work and deliver when the turn completes (or when they
// disappear); internal threads (guardian, review, compaction, memory) are left out.
//
// Status: applied by edges (turn start/end in the rollout, hook events), the newest information wins; a
// reread rollout never overwrites the 'waiting' of a newer PermissionRequest. Short and synchronous boot (only the
// end window of large rollouts; the start is read later, in the background), with endBoot in a `finally`.
import { createReadStream, readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { AccountUsage, Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail, LineBuffer, warnOversizedLine } from '../tail';
import type { TerminalParser } from '../terminal';
import { codexPlanLabel, detectCodexAccounts } from './accounts';
import { readLocks, readRolloutHead, rolloutDirs, RolloutIndex, parseRolloutName, LOCKS_DIR, type LockInfo } from './files';
import type { CodexLive } from './live';
import {
  createCodexState,
  describeCodexTool,
  isThreadId,
  parseRolloutLine,
  type CodexLineResult,
  type CodexState,
  type RolloutMeta,
} from './rollout';
import { createCodexTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

/** Minimum age of the lock to count as an open session (the maintenance locks last less). */
export const LOCK_SETTLE_MS = 3_000;
/** Lock present with the rollout idle for longer than this and no hook event: old lock from a crash. */
export const STALE_LOCK_MS = 12 * 3600_000;
/** No `thread-writer-locks/`: presence = rollout modified in the last 30 min. */
export const FALLBACK_RECENT_MS = 30 * 60_000;
/** A hook event keeps the agent present for this long (with no visible lock). */
export const HOOK_PRESENCE_MS = 60_000;
/** SessionEnd with the lock still present: closes anyway after this. */
export const SESSION_END_GRACE_MS = 5_000;
/** Time the thread needs to stay absent to be taken as ended. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/** 'working' with no write to the rollout and no hook event for this long: the turn died (crash). */
export const WORKING_QUIET_MS = 30 * 60_000;
/** No turn events (old legacy): wrote a moment ago = working. */
const LEGACY_WORKING_MS = 90_000;
/** Activities recovered from the start of a large rollout for the long timeline. */
const PREFIX_HISTORY = 120;
/** Results kept when reading a rollout before the agent enters the office. */
const BACKLOG_MAX = 400;
/** Account with no open session at startup: how many recent rollouts to try until finding one with the plan usage. */
const SEED_USAGE_FILES = 8;
const MAIN_ROLE = tr('Main agent (Codex)');
const SUB_ROLE = tr('Subagent (Codex)');

const HOOK_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Interrupt',
]);

export interface CodexSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Codex folders read by this process (in Docker, the mounted ones), one per account. */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** How much of the end of each rollout is read when the session opens (default 1 MB). */
  tailBytes?: number;
  /** Turns off fs.watch (tests). */
  watch?: boolean;
}

interface CodexAccount {
  id: string;
  /** Folder read by this process. */
  dir: string;
  /** Folder to display (in Docker, the host's). */
  configDir: string;
  index: RolloutIndex;
  /** Locks seen in the last cycle (null = no locks folder). */
  locks: Map<string, LockInfo> | null;
  /** Mode without locks: rollouts modified recently (thread → mtime), rechecked every 10 s. */
  recent: Map<string, number>;
  recentAt: number;
  usage?: AccountUsage;
  plan?: string;
  error?: string;
}

interface ThreadTracker {
  key: string;
  acc: CodexAccount;
  threadId: string;
  /** main/sub from session_meta (or from the hook); internal = stays out of the office. */
  kind: 'main' | 'sub' | 'internal';
  parentThreadId?: string;
  meta?: RolloutMeta;
  rolloutPath?: string;
  nextResolveAt: number;
  tail?: FileTail;
  state: CodexState;
  /** Results read before the agent enters the office (they go as history, without feed). */
  backlog: CodexLineResult[];
  inOffice: boolean;
  hookCwd?: string;
  hookRole?: string;
  status: AgentStatus;
  /** When the status was decided (rollout line or hook event): older information does not change it. */
  statusAt: number;
  waitingFor?: string;
  lastHookAt?: number;
  /** mtime of the rollout at the last read. */
  lastWriteAt?: number;
  endedAt?: number;
  missingSince?: number;
  /** Subagent that has already delivered (turn completed). */
  subDone: boolean;
  /** Created just now by a hook (SubagentStart): enters even with no turn seen. */
  hookSpawned?: boolean;
  watcher?: FSWatcher;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function roleOf(raw: string | undefined): string {
  if (!raw) return SUB_ROLE;
  const r = raw.trim();
  return r ? `${r[0].toUpperCase()}${r.slice(1)}` : SUB_ROLE;
}

export class CodexSource implements AgentSource, CodexLive {
  readonly provider = 'codex' as const;
  private accs: CodexAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private threads = new Map<string, ThreadTracker>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private prefixChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly tailBytes: number;
  private readonly useWatch: boolean;
  private stopped = false;

  constructor(private readonly opts: CodexSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    this.useWatch = opts.watch ?? true;
    const env = opts.env ?? process.env;
    const claude = opts.accounts.entries();
    this.detected = detectCodexAccounts(opts.dirs, {
      env,
      home: opts.home,
      taken: { shorts: claude.map((e) => e.detected.short), colors: claude.map((e) => e.detected.color) },
    });
    this.register();
  }

  /** Registers (again) the accounts in the AccountsService, always in the same order: the ids do not change. */
  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      'codex',
      this.opts.dirs.map((dir, i) => ({ dir, detected: this.detected[i] })),
    );
    this.entries = entries;
    const prev = new Map(this.accs.map((a) => [a.dir, a]));
    this.accs = entries.map((e) => {
      const old = prev.get(e.dir);
      if (old) {
        old.id = e.id;
        old.configDir = e.detected.configDir;
        return old;
      }
      return { id: e.id, dir: e.dir, configDir: e.detected.configDir, index: new RolloutIndex(e.dir, this.now), locks: null, recent: new Map(), recentAt: -Infinity };
    });
  }

  /** Codex accounts (final ids, in the AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  /** Rebuilds the open sessions without generating notices. Synchronous and short. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      for (const acc of this.accs) acc.index.scanAll();
      this.poll(true);
      for (const acc of this.accs) if (!acc.usage) this.seedUsage(acc);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    for (const t of this.threads.values()) this.unwatch(t);
  }

  sources(): SourceInfo[] {
    return this.accs.map((acc) => {
      let sessions = 0;
      for (const t of this.threads.values()) if (t.acc === acc && t.kind === 'main' && t.inOffice) sessions++;
      const info: SourceInfo = { label: acc.id, provider: 'codex', path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.threads.get(agentId);
    return t?.inOffice ? t.rolloutPath : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.threads.has(agentId) ? createCodexTerminalParser() : undefined;
  }

  /** Waits for the reads of the start of the rollouts (tests). */
  idle(): Promise<void> {
    return this.prefixChain;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`codex-poll:${errMsg(err)}`, tr('Codex: read cycle failed: {0}', [errMsg(err)]));
    }
  }

  private schedule(): void {
    if (this.kick || this.stopped) return;
    const wait = Math.max(60, 150 - (this.now() - this.lastPollAt));
    this.kick = setTimeout(() => {
      this.kick = null;
      this.safePoll();
    }, wait);
    this.kick.unref?.();
  }

  poll(boot = false): void {
    const now = (this.lastPollAt = this.now());
    const seen = new Set<string>();
    for (const acc of this.accs) {
      const present = this.presentThreads(acc, now);
      for (const [threadId, via] of present) {
        const key = `${acc.id}:${threadId}`;
        let t = this.threads.get(key);
        if (!t) {
          t = this.newTracker(acc, threadId);
          this.threads.set(key, t);
        }
        try {
          this.syncThread(t, via, now, boot);
        } catch (err) {
          log.warnOnce(`codex-thread:${key}:${errMsg(err)}`, tr('Codex: thread {0}: {1}', [key, errMsg(err)]));
        }
        seen.add(key);
      }
    }
    for (const [key, t] of [...this.threads]) {
      if (seen.has(key)) continue;
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      this.leave(t);
      this.unwatch(t);
      this.threads.delete(key);
    }
    // Subagents left for later (the parent entered in this cycle).
    for (const t of this.threads.values()) if (t.kind === 'sub' && !t.inOffice && seen.has(t.key)) this.reconcile(t, now);
  }

  /**
   * Threads present for an account and why: 'lock' (lock old enough), 'recent' (no locks folder:
   * rollout modified recently) or 'hook' (recent hook event).
   */
  private presentThreads(acc: CodexAccount, now: number): Map<string, 'lock' | 'recent' | 'hook'> {
    const out = new Map<string, 'lock' | 'recent' | 'hook'>();
    acc.locks = readLocks(acc.dir);
    if (acc.locks) {
      this.watchDir(`${acc.dir}${sep}${LOCKS_DIR}`);
      for (const lock of acc.locks.values()) {
        const known = this.threads.get(`${acc.id}:${lock.threadId}`);
        // Lock too new (maintenance?): waits (the ~1 s polling checks again). What is already in the office
        // does not need to wait again.
        if (now - lock.createdAt < LOCK_SETTLE_MS && !known?.inOffice) continue;
        out.set(lock.threadId, 'lock');
      }
    } else {
      if (now - acc.recentAt >= 10_000) {
        acc.recentAt = now;
        acc.recent = new Map(acc.index.recentlyModified(FALLBACK_RECENT_MS).map((r) => [r.threadId, r.mtimeMs]));
      }
      for (const [threadId, mtime] of acc.recent) {
        const t = this.threads.get(`${acc.id}:${threadId}`);
        const last = Math.max(mtime, t?.lastWriteAt ?? 0);
        if (now - last <= FALLBACK_RECENT_MS) out.set(threadId, 'recent');
      }
    }
    for (const t of this.threads.values()) {
      if (t.acc !== acc || out.has(t.threadId)) continue;
      if (t.lastHookAt !== undefined && now - t.lastHookAt < HOOK_PRESENCE_MS) out.set(t.threadId, 'hook');
    }
    return out;
  }

  private newTracker(acc: CodexAccount, threadId: string): ThreadTracker {
    return {
      key: `${acc.id}:${threadId}`,
      acc,
      threadId,
      kind: 'main',
      nextResolveAt: 0,
      state: createCodexState(),
      backlog: [],
      inOffice: false,
      status: 'idle',
      statusAt: 0,
      subDone: false,
    };
  }

  /** One cycle of a present thread: finds/reads the rollout and decides whether it is (or stays) in the office. */
  private syncThread(t: ThreadTracker, via: 'lock' | 'recent' | 'hook', now: number, boot: boolean): void {
    delete t.missingSince;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false; // left the office (grace ended)
    this.pump(t, boot);
    this.reconcile(t, now, via);
    if (t.inOffice && t.kind === 'main') {
      this.quietCheck(t, now);
      this.opts.office.fillWorkingActivity(t.key);
    }
  }

  /** Should the thread be in the office now? Enters, leaves or changes rooms as the case may be. */
  private reconcile(t: ThreadTracker, now: number, via?: 'lock' | 'recent' | 'hook'): void {
    const want = this.wanted(t, now, via);
    if (!want) {
      if (t.inOffice) this.leave(t);
      return;
    }
    if (!t.inOffice) this.enter(t, now);
  }

  private wanted(t: ThreadTracker, now: number, via?: 'lock' | 'recent' | 'hook'): boolean {
    if (t.kind === 'internal') return false;
    const hookRecent = t.lastHookAt !== undefined && now - t.lastHookAt < HOOK_PRESENCE_MS;
    // SessionEnd: closes, unless something new happened afterward.
    if (t.endedAt !== undefined) {
      const lock = t.acc.locks?.get(t.threadId);
      const newer = (t.lastHookAt ?? 0) > t.endedAt || (t.lastWriteAt ?? 0) > t.endedAt + 1_000 || (lock?.createdAt ?? 0) > t.endedAt;
      if (newer) delete t.endedAt;
      else if (!lock || now - t.endedAt >= SESSION_END_GRACE_MS) return false;
    }
    if (!hookRecent && via === 'lock') {
      const lock = t.acc.locks?.get(t.threadId);
      // Old lock from a crash: the lock is old and the rollout has been still for a long time (or does not even exist).
      // An old thread resumed now has a new lock (Codex creates the file on load and deletes it on unload).
      const rolloutIdle = !t.rolloutPath || (t.lastWriteAt !== undefined && now - t.lastWriteAt > STALE_LOCK_MS);
      if (lock && now - lock.createdAt > STALE_LOCK_MS && rolloutIdle) return false;
    }
    // Without the project (open session with no prompt yet, only the lock) there is no room for the main one: waits for
    // the rollout or a hook to tell the cwd. This also holds a subagent's lock until its rollout says whose it is.
    if (t.kind === 'main' && !this.cwdOf(t)) return false;
    if (t.kind === 'sub') {
      const parent = this.parentKey(t);
      if (!parent || !this.opts.office.has(parent) || this.opts.office.isSubDone(parent) || this.opts.office.get(parent)?.status === 'offline') return false;
      // A subagent only shows up while working (or just created by the hook); after delivering, it leaves.
      if (!t.inOffice && t.status !== 'working' && t.status !== 'waiting' && !t.hookSpawned) return false;
    }
    return true;
  }

  private parentKey(t: ThreadTracker): string | undefined {
    if (!t.parentThreadId) return undefined;
    const direct = `${t.acc.id}:${t.parentThreadId}`;
    return direct;
  }

  /** Known project of the thread (session_meta or hook). */
  private cwdOf(t: ThreadTracker): string | undefined {
    return t.meta?.cwd ?? t.hookCwd;
  }

  private enter(t: ThreadTracker, now: number): void {
    const office = this.opts.office;
    if (t.kind === 'main') {
      const cwd = this.cwdOf(t)!;
      office.addMain({
        id: t.key,
        provider: 'codex',
        account: t.acc.id,
        sessionId: t.threadId,
        cwd,
        role: MAIN_ROLE,
        startedAt: t.meta?.startedAt ?? t.state.firstAt ?? now,
        status: t.status,
        waitingFor: t.waitingFor,
      });
      t.inOffice = office.has(t.key);
      if (!t.inOffice) return;
      // Reopened within the grace period: the status may have changed while it was away.
      office.setStatus(t.key, t.status, t.waitingFor);
    } else {
      const parent = this.parentKey(t)!;
      const added = office.addSub({
        id: t.key,
        parentId: parent,
        sessionId: t.threadId,
        role: roleOf(t.meta?.agentRole ?? t.hookRole),
        title: t.state.title,
        background: false,
        startedAt: t.meta?.startedAt ?? t.state.firstAt ?? now,
      });
      if (!added) return;
      t.inOffice = true;
      t.subDone = false;
      delete t.hookSpawned;
      // addSub starts as 'working': an approval request seen before it entered counts right away.
      if (t.status === 'waiting') office.setStatus(t.key, 'waiting', t.waitingFor);
    }
    this.flushBacklog(t);
    this.applySummary(t);
  }

  /** Leaves the office: the main one ends; a subagent delivers (if it had not delivered yet). */
  private leave(t: ThreadTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'sub') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
    } else office.closeMain(t.key);
    t.inOffice = false;
  }

  /** Takes the tracker's status to the office (the subagent delivers when it goes idle and returns when working). */
  private statusToOffice(t: ThreadTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.setStatus(t.key, t.status, t.waitingFor);
      return;
    }
    if (t.kind !== 'sub') return;
    if (t.status === 'idle') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
      return;
    }
    if (t.subDone) {
      office.reactivateSub(t.key);
      t.subDone = office.isSubDone(t.key);
    }
    if (!t.subDone) office.setStatus(t.key, t.status, t.waitingFor);
  }

  // ---------------------------------------------------------------- rollout

  /** Finds the rollout (no rush: at most every 3 s per thread) and reads whatever is new. */
  private pump(t: ThreadTracker, boot: boolean): void {
    const now = this.now();
    if (now >= t.nextResolveAt) {
      t.nextResolveAt = now + (boot ? 0 : 3_000);
      const path = t.acc.index.find(t.threadId);
      if (path && !samePath(path, t.tail?.path)) {
        this.load(t, path);
        return;
      }
      if (!path && !t.tail && t.acc.index.isCompressedOnly(t.threadId)) {
        log.warnOnce('codex-zst', tr("Codex: there are compressed conversations (.jsonl.zst) that Habblaud can't read yet; they show no details."));
      }
    }
    if (!t.tail) return;
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = t.tail.read();
      } catch (err) {
        log.warnOnce(`codex-read:${t.key}`, tr('Codex: unreadable rollout for {0} ({1}).', [t.key, errMsg(err)]));
        return;
      }
      if (r.missing) {
        // Deleted or moved (archived, compressed): looks again.
        this.unwatch(t);
        delete t.tail;
        delete t.rolloutPath;
        t.nextResolveAt = 0;
        return;
      }
      t.lastWriteAt = t.tail.mtimeMs;
      if (r.reset) {
        // Rewritten at the same path (e.g., codex migrate-rollouts): rereads it as history.
        this.load(t, t.tail.path);
        return;
      }
      for (const line of r.lines) this.apply(t, parseRolloutLine(t.state, line, { idPrefix: t.key, now: this.now() }), true);
      if (r.lines.length) this.applySummary(t);
      if (!r.more) break;
    }
  }

  /** Reads the start (session_meta, title) and the rollout's end window; the rest of the start goes in background. */
  private load(t: ThreadTracker, path: string): void {
    this.unwatch(t);
    const head = readRolloutHead(path);
    if (head.meta) this.setMeta(t, head.meta);
    const tail = new FileTail(path);
    const start = tail.seekTail(this.tailBytes);
    t.tail = tail;
    t.rolloutPath = path;
    t.state = createCodexState(head.meta);
    if (head.title) t.state.title = head.title;
    t.backlog = [];
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      for (const line of r.lines) this.apply(t, parseRolloutLine(t.state, line, { idPrefix: t.key, now: this.now() }), false);
      if (!r.more) break;
    }
    t.lastWriteAt = tail.mtimeMs;
    this.settleStatus(t);
    if (t.inOffice) {
      this.flushBacklog(t);
      this.statusToOffice(t);
    }
    this.applySummary(t);
    this.watchFile(t, path);
    if (start > 0) this.queuePrefix(t, path, start);
  }

  private setMeta(t: ThreadTracker, meta: RolloutMeta): void {
    t.meta = meta;
    if (meta.internal) t.kind = 'internal';
    else if (meta.parentThreadId) {
      if (t.kind === 'main' && t.inOffice) {
        // It showed up as an open session (no rollout yet) and is a subagent: leaves and comes back as a subagent.
        this.opts.office.closeMain(t.key);
        t.inOffice = false;
      }
      t.kind = 'sub';
      t.parentThreadId = meta.parentThreadId;
    }
  }

  /**
   * Status after reading the rollout window: the open turn (or, in old legacy without turn events, a recent
   * write) is 'working'. A newer status coming from a hook wins.
   */
  private settleStatus(t: ThreadTracker): void {
    const s = t.state;
    const at = s.lastAt ?? 0;
    if (at < t.statusAt) return;
    let status: AgentStatus;
    if (s.turnOpen !== undefined) status = s.turnOpen ? 'working' : 'idle';
    else status = s.lastAt !== undefined && this.now() - s.lastAt < LEGACY_WORKING_MS ? 'working' : 'idle';
    if (status === 'working' && this.now() - Math.max(t.lastWriteAt ?? 0, at) > WORKING_QUIET_MS) status = 'idle';
    t.status = status;
    t.statusAt = at;
    delete t.waitingFor;
  }

  /** Applies a line result: live, it goes straight to the office; in the initial load, it stays in the backlog. */
  private apply(t: ThreadTracker, r: CodexLineResult, live: boolean): void {
    for (const sig of r.signals) {
      switch (sig.type) {
        case 'meta':
          this.setMeta(t, sig.meta);
          break;
        case 'usage':
          this.pushUsage(t.acc, sig.usage, sig.plan);
          break;
        case 'turnStart':
          this.decide(t, 'working', r.at, undefined, live);
          break;
        case 'turnEnd':
          this.decide(t, 'idle', r.at, undefined, live);
          break;
        case 'progress':
          if (t.status === 'waiting') this.decide(t, 'working', r.at, undefined, live);
          break;
        default:
          break;
      }
    }
    if (!live || !t.inOffice) {
      if (r.activities.length || r.signals.some((s) => s.type === 'github')) {
        t.backlog.push(r);
        if (t.backlog.length > BACKLOG_MAX) t.backlog.splice(0, t.backlog.length - BACKLOG_MAX);
      }
      return;
    }
    this.toOffice(t, r, true);
  }

  private toOffice(t: ThreadTracker, r: CodexLineResult, live: boolean): void {
    const office = this.opts.office;
    for (const a of r.activities) office.addActivity(t.key, a.activity, a.current, { feed: live });
    for (const sig of r.signals) {
      // Only what arrives live animates the room; the initial load goes to the history.
      if (sig.type === 'github') office.githubEvent(t.key, sig.event, { key: sig.key, at: r.at, live });
    }
  }

  private flushBacklog(t: ThreadTracker): void {
    const backlog = t.backlog;
    t.backlog = [];
    for (const r of backlog) this.toOffice(t, r, false);
  }

  /**
   * Changes the status on an edge (turn start/end, hook): information older than the last decision does not count.
   * `live` = applies to the office now (the initial load only stores; the status enters along with the agent).
   */
  private decide(t: ThreadTracker, status: AgentStatus, at: number, waitingFor: string | undefined, live: boolean): void {
    if (at < t.statusAt) return;
    t.statusAt = at;
    t.status = status;
    if (waitingFor) t.waitingFor = waitingFor;
    else delete t.waitingFor;
    if (live) this.statusToOffice(t);
  }

  /** 'working' with no news at all for a long time (turn dead in a crash): becomes 'idle'. */
  private quietCheck(t: ThreadTracker, now: number): void {
    if (t.status !== 'working') return;
    const last = Math.max(t.lastWriteAt ?? 0, t.lastHookAt ?? 0, t.statusAt);
    if (now - last > WORKING_QUIET_MS) this.decide(t, 'idle', now, undefined, true);
  }

  private applySummary(t: ThreadTracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    if (s.title) summary.title = s.title;
    if (s.model) summary.model = s.model;
    const branch = s.gitBranch ?? t.meta?.gitBranch;
    if (branch) summary.gitBranch = branch;
    if (s.firstAt !== undefined) summary.firstAt = s.firstAt;
    if (s.lastAt !== undefined) summary.lastAt = s.lastAt;
    this.opts.office.applyTranscript(t.key, summary);
  }

  /** Start of a large rollout (before the window read): numbers, title and the long timeline. */
  private queuePrefix(t: ThreadTracker, path: string, end: number): void {
    const state = t.state;
    this.prefixChain = this.prefixChain
      .then(async () => {
        if (this.stopped) return;
        const prefix = await scanPrefix(path, end, t.key, PREFIX_HISTORY);
        if (this.threads.get(t.key) !== t || t.state !== state) return;
        state.stats.toolCalls += prefix.state.stats.toolCalls;
        state.stats.subagents += prefix.state.stats.subagents;
        state.title ??= prefix.state.title;
        state.model ??= prefix.state.model;
        if (!state.tasks.length && prefix.state.tasks.length) state.tasks = prefix.state.tasks;
        if (prefix.state.firstAt !== undefined && (state.firstAt === undefined || prefix.state.firstAt < state.firstAt)) state.firstAt = prefix.state.firstAt;
        this.applySummary(t);
        if (t.inOffice) this.opts.office.mergeHistory(t.key, prefix.activities);
      })
      .catch((err) => log.warnOnce(`codex-prefix:${path}`, tr("Codex: couldn't read the start of a rollout ({0}).", [errMsg(err)])));
  }

  // ---------------------------------------------------------------- plan usage

  /** Account usage (and the plan with it): the most recent among its sessions counts. */
  private pushUsage(acc: CodexAccount, usage: AccountUsage, plan: string | undefined): void {
    if (acc.usage && usage.fetchedAt < acc.usage.fetchedAt) return;
    acc.usage = usage;
    this.opts.accounts.setUsage(acc.id, usage);
    this.pushPlan(acc, plan);
  }

  /** The plan (rate_limits.plan_type) goes into the account. */
  private pushPlan(acc: CodexAccount, plan: string | undefined): void {
    const label = codexPlanLabel(plan);
    if (label && label !== acc.plan) {
      acc.plan = label;
      const i = this.accs.indexOf(acc);
      if (i >= 0 && this.detected[i]) {
        this.detected[i] = { ...this.detected[i], plan: label };
        this.register();
      }
    }
  }

  /**
   * Account with no open session at startup: the usage from the most recent rollout that has numbers (it becomes
   * "outdated" with age: Codex's numbers only refresh with some session running). By mtime across ALL date folders (a
   * resumed session stays in the file in the old folder), trying the most recent SEED_USAGE_FILES: the last one may
   * have no `token_count` at all (session with no response, or archived right away).
   */
  private seedUsage(acc: CodexAccount): void {
    const files: Array<{ path: string; mtimeMs: number }> = [];
    for (const dir of rolloutDirs(acc.dir)) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const r = parseRolloutName(name);
        if (!r || r.compressed) continue;
        try {
          files.push({ path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs });
        } catch {
          // gone
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let plan: string | undefined;
    for (const f of files.slice(0, SEED_USAGE_FILES)) {
      try {
        const tail = new FileTail(f.path);
        tail.seekTail(256 * 1024);
        const state = createCodexState();
        for (let i = 0; i < 4; i++) {
          const r = tail.read();
          for (const line of r.lines) parseRolloutLine(state, line, { idPrefix: '', now: this.now(), activities: false });
          if (!r.more) break;
        }
        plan ??= state.planType;
        if (state.usage) return this.pushUsage(acc, state.usage, state.planType ?? plan);
      } catch {
        // unreadable now: tries the next one
      }
    }
    if (!acc.plan) this.pushPlan(acc, plan);
  }

  // ---------------------------------------------------------------- hooks (CodexLive)

  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    try {
      return this.hookEvent(account, input);
    } catch (err) {
      log.warnOnce(`codex-hook:${errMsg(err)}`, tr('Codex: hook event ignored ({0}).', [errMsg(err)]));
      return false;
    }
  }

  private hookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    const event = str(input.hook_event_name);
    if (!event || !HOOK_EVENTS.has(event)) return false;
    const root = str(input.session_id)?.toLowerCase();
    const agent = str(input.agent_id)?.toLowerCase();
    if (!isThreadId(root)) return false;
    const target = agent && isThreadId(agent) ? agent : root;
    const agentType = str(input.agent_type);
    if (agentType && /guardian/i.test(agentType)) return false;
    const acc = this.accountFor(account, input, target);
    if (!acc) return false;
    const now = this.now();
    const cwd = str(input.cwd);
    const office = this.opts.office;

    if (event === 'SessionEnd') {
      const t = this.threads.get(`${acc.id}:${root}`);
      if (!t) return false;
      t.endedAt = now;
      delete t.lastHookAt;
      this.reconcile(t, now);
      this.schedule();
      return true;
    }

    // Subagent: the child thread comes in agent_id (the parent, until we know from session_meta, is the root).
    const isSubEvent = target !== root || event === 'SubagentStart' || event === 'SubagentStop';
    const subId = event === 'SubagentStart' || event === 'SubagentStop' ? (agent && isThreadId(agent) ? agent : undefined) : target !== root ? target : undefined;
    if (isSubEvent && !subId) return false;
    const rootT = this.touch(acc, root, now, cwd);
    const t = subId ? this.touch(acc, subId, now, cwd, root, agentType) : rootT;
    this.hintTranscript(acc, subId ?? root, event === 'SubagentStop' ? str(input.agent_transcript_path) : subId ? undefined : str(input.transcript_path));
    this.reconcile(rootT, now, 'hook');

    switch (event) {
      case 'SubagentStart':
        t.hookSpawned = true;
        this.decide(t, 'working', now, undefined, true);
        break;
      case 'SubagentStop':
        this.decide(t, 'idle', now, undefined, true);
        break;
      case 'UserPromptSubmit':
      case 'PostToolUse':
      case 'PreCompact':
      case 'PostCompact':
        this.decide(t, 'working', now, undefined, true);
        break;
      case 'PreToolUse': {
        this.decide(t, 'working', now, undefined, true);
        if (t !== rootT) this.reconcile(t, now, 'hook');
        const toolName = str(input.tool_name) ?? 'tool';
        const toolInput = rec(input.tool_input) ?? {};
        const { desc, tool } = describeCodexTool(toolName, toolInput);
        const id = str(input.tool_use_id);
        const act: Activity = { id: `${t.key}#${id ?? `hook${now.toString(36)}`}`, at: now, ...desc, tool };
        if (t.inOffice) office.addActivity(t.key, act, true);
        break;
      }
      case 'PermissionRequest':
        this.decide(t, 'waiting', now, tr('approve a command'), true);
        break;
      case 'Stop':
      case 'Interrupt':
        this.decide(t, 'idle', now, undefined, true);
        break;
      default:
        break;
    }
    if (t !== rootT) this.reconcile(t, now, 'hook');
    return true;
  }

  /** Tracker of the thread (created if needed), with the presence given by the hook. */
  private touch(acc: CodexAccount, threadId: string, now: number, cwd: string | undefined, parent?: string, agentType?: string): ThreadTracker {
    const key = `${acc.id}:${threadId}`;
    let t = this.threads.get(key);
    if (!t) {
      t = this.newTracker(acc, threadId);
      this.threads.set(key, t);
    }
    t.lastHookAt = now;
    delete t.missingSince;
    if (t.endedAt !== undefined && now > t.endedAt) delete t.endedAt;
    if (cwd) t.hookCwd ??= cwd;
    if (parent && !t.meta && t.kind === 'main') {
      t.kind = 'sub';
      t.parentThreadId = parent;
    }
    if (agentType) t.hookRole ??= agentType;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false;
    this.pump(t, false);
    return t;
  }

  /** The hook's `transcript_path`, if it is a rollout inside the account folder (in Docker it is the host's: no use). */
  private hintTranscript(acc: CodexAccount, threadId: string, path: string | undefined): void {
    if (!path) return;
    const t = this.threads.get(`${acc.id}:${threadId}`);
    try {
      const real = realpathSync(path);
      const root = realpathSync(acc.dir);
      if (!real.startsWith(root + sep) || parseRolloutName(basename(real))?.threadId !== threadId) return;
      if (samePath(real, t?.tail?.path)) return;
      acc.index.hint(threadId, real);
      if (t?.tail) this.load(t, real);
      else if (t) t.nextResolveAt = 0;
    } catch {
      // does not exist here (Docker) or has not been created yet
    }
  }

  /**
   * Account of an event: `account` (id or folder), else the one from `transcript_path`, else the one that already
   * knows the thread; with only one account, that one.
   */
  private accountFor(account: string | undefined, input: Record<string, unknown>, threadId: string): CodexAccount | undefined {
    const norm = (p: string) => {
      try {
        return resolve(p);
      } catch {
        return p;
      }
    };
    if (account) {
      const byId = this.accs.find((a) => a.id === account);
      if (byId) return byId;
      const abs = norm(account);
      const byDir = this.accs.find((a) => norm(a.dir) === abs || norm(a.configDir) === abs);
      if (byDir) return byDir;
    }
    for (const raw of [str(input.transcript_path), str(input.agent_transcript_path)]) {
      if (!raw) continue;
      const p = norm(raw);
      const byPath = this.accs.find((a) => p.startsWith(norm(a.dir) + sep) || p.startsWith(norm(a.configDir) + sep));
      if (byPath) return byPath;
    }
    const known = this.accs.filter((a) => this.threads.has(`${a.id}:${threadId}`));
    if (known.length === 1) return known[0];
    if (account) {
      const byName = this.accs.find((a) => basename(a.dir) === basename(account) || basename(a.configDir) === basename(account));
      if (byName) return byName;
    }
    return this.accs.length === 1 ? this.accs[0] : undefined;
  }

  // ---------------------------------------------------------------- fs.watch (accelerator)

  private watchDir(dir: string): void {
    if (!this.useWatch || this.dirWatchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, () => this.schedule());
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, w);
    } catch {
      // not supported: polling covers it
    }
  }

  private watchFile(t: ThreadTracker, path: string): void {
    if (!this.useWatch) return;
    this.unwatch(t);
    try {
      const w = watch(path, { persistent: false }, () => this.schedule());
      w.on('error', () => w.close());
      t.watcher = w;
    } catch {
      // not supported: polling covers it
    }
  }

  private unwatch(t: ThreadTracker): void {
    t.watcher?.close();
    delete t.watcher;
  }
}

/** The same file, even if a path goes through a symlink (the index keeps the folder's; the hook sends realpath). */
function samePath(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Reads as a stream (without blocking the event loop) the bytes [0, end) of a rollout: the numbers, the title and
 * the last `keep` activities before the window read when the session opens.
 */
export async function scanPrefix(path: string, end: number, idPrefix: string, keep: number): Promise<{ state: CodexState; activities: Activity[] }> {
  const state = createCodexState();
  let activities: Activity[] = [];
  if (end <= 0) return { state, activities };
  const ctx = { idPrefix, now: Date.now(), activities: keep > 0 };
  const take = (line: string) => {
    const r = parseRolloutLine(state, line, ctx);
    for (const a of r.activities) activities.push(a.activity);
    if (activities.length > keep * 2) activities = activities.slice(-keep);
  };
  const pending = new LineBuffer();
  let discarded = 0;
  const stream = createReadStream(path, { start: 0, end: end - 1, highWaterMark: 1024 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const fed = pending.push(chunk);
    discarded += fed.discarded;
    for (const buf of fed.lines) {
      const line = buf.toString('utf8');
      if (line) take(line);
    }
  }
  const rest = pending.flush();
  if (rest?.length) take(rest.toString('utf8'));
  if (discarded) warnOversizedLine(path);
  return { state, activities: activities.slice(-keep) };
}
