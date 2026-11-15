// Copilot CLI agent source (AgentSource 'copilot', see sources/source.ts): watches the sessions of each Copilot
// folder (COPILOT_HOME, ~/.copilot) and feeds the Office. Read-only, by polling every second (fs.watch only speeds it
// up), with the files listed in files.ts and nothing else.
//
// Presence: a session is in the office when its events.jsonl does not end in `session.shutdown` (authoritative) AND
// it is listed in open-sessions-state.json OR the events file changed within QUIET_WINDOW_MS. The open-sessions
// file is only a hint: it can still list sessions that already shut down, and in Docker a single-file mount can go
// stale; a session listed there with no new event for STALE_OPEN_MS is taken as a crash and leaves. After
// session.shutdown only the cheap check of every poll stays (no fs.watch, no backlog, no read of the start of the
// file); new events after it (a resumed session) bring all of that back. A session folder without events.jsonl is
// skipped. The room is the `cwd` of workspace.yaml (or, without it, of session.start).
//
// Status: derived from the events (events.ts): open permission prompt = 'waiting', running turn = 'working', else
// 'idle'; 'working' with no write for WORKING_QUIET_MS (a dead turn) becomes 'idle', and so does 'waiting' with no
// write for WAITING_QUIET_MS (a process killed on a permission prompt: no "needs you" for hours). The open-sessions
// `refreshedAt` counts as activity there only when newer than the last write; it is no heartbeat. Messages and
// approvals from the office are not supported for Copilot, and Copilot writes no usage limits: there is no usage bar.
// Subagents are not shown (they stay inside the main session's events). Short and synchronous boot (only the end
// window of large files; the start is read later, in the background), with endBoot in a `finally`.
import { createReadStream, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail, LineBuffer, warnOversizedLine } from '../tail';
import type { TerminalParser } from '../terminal';
import { detectCopilotAccounts } from './accounts';
import { copilotStatus, createCopilotState, parseEventLine, type CopilotLineResult, type CopilotState } from './events';
import { EVENTS_FILE, isCopilotHome, listSessionIds, readOpenSessions, readWorkspace, sessionFile, SESSION_STATE_DIR, type WorkspaceInfo } from './files';
import { createCopilotTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

/** Not listed as open: presence = events.jsonl modified within this window. */
export const QUIET_WINDOW_MS = 30 * 60_000;
/** Listed as open but with no new event for this long: an old entry from a crash. */
export const STALE_OPEN_MS = 12 * 3600_000;
/** 'working' with no write to the events file for this long: the turn died. */
export const WORKING_QUIET_MS = 30 * 60_000;
/** 'waiting' with no write to the events file (nor a newer open-sessions refreshedAt) for this long: the process died. */
export const WAITING_QUIET_MS = 3600_000;
/** Full rescan of session-state/ (stat of every events.jsonl), at most this often. */
const RESCAN_MS = 10_000;
/** Activities recovered from the start of a large file for the long timeline. */
const PREFIX_HISTORY = 120;
/** Results kept when reading a file before the agent enters the office. */
const BACKLOG_MAX = 400;
/** Lines kept (in characters) for the status replay after the start of a large file is read; above it, no replay. */
const REPLAY_MAX_CHARS = 8 * 1024 * 1024;
const MAIN_ROLE = tr('Main agent (Copilot)');

export interface CopilotSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Copilot folders read by this process (in Docker, the mounted ones), one per account. */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** How much of the end of each events file is read when the session opens (default 1 MB). */
  tailBytes?: number;
  /** Turns off fs.watch (tests). */
  watch?: boolean;
}

interface CopilotAccount {
  id: string;
  /** Folder read by this process. */
  dir: string;
  /** Folder to display (in Docker, the host's). */
  configDir: string;
  /** Sessions with events.jsonl modified recently (id → mtime), from the last rescan. */
  recent: Map<string, number>;
  scanAt: number;
  error?: string;
}

interface SessionTracker {
  key: string;
  acc: CopilotAccount;
  sessionId: string;
  path?: string;
  tail?: FileTail;
  state: CopilotState;
  workspace: WorkspaceInfo;
  /** Results read before the agent enters the office (they go as history, without feed). */
  backlog: CopilotLineResult[];
  inOffice: boolean;
  status: AgentStatus;
  waitingFor?: string;
  /** mtime of the events file at the last read. */
  lastWriteAt?: number;
  /** `refreshedAt` of the session in open-sessions-state.json (while listed). */
  refreshedAt?: number;
  /** session.shutdown handled: no fs.watch, no backlog, no read of the start (until new events). */
  ended?: boolean;
  /** End of the start of the file still to read, put off by the shutdown (read if the session is resumed). */
  prefixEnd?: number;
  watcher?: FSWatcher;
  /**
   * While the start of a large file is read in the background: every line read since the window start, in order, to
   * replay on top of the start and re-derive the status (a turn or a permission prompt opened before the window).
   */
  replay?: { lines: string[]; chars: number };
}

export class CopilotSource implements AgentSource {
  readonly provider = 'copilot' as const;
  private accs: CopilotAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private sessions = new Map<string, SessionTracker>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private prefixChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly tailBytes: number;
  private readonly useWatch: boolean;
  private stopped = false;

  constructor(private readonly opts: CopilotSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    this.useWatch = opts.watch ?? true;
    const others = opts.accounts.allEntries();
    this.detected = detectCopilotAccounts(opts.dirs, {
      env: opts.env ?? process.env,
      home: opts.home,
      taken: { shorts: others.map((e) => e.detected.short), colors: others.map((e) => e.detected.color) },
    });
    this.entries = opts.accounts.setProviderAccounts(
      'copilot',
      opts.dirs.map((dir, i) => ({ dir, detected: this.detected[i] })),
    );
    this.accs = this.entries.map((e) => ({ id: e.id, dir: e.dir, configDir: e.detected.configDir, recent: new Map(), scanAt: -Infinity }));
  }

  /** Copilot accounts (final ids, in the AccountsService). */
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
      this.poll(true);
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
    for (const t of this.sessions.values()) this.unwatch(t);
  }

  sources(): SourceInfo[] {
    return this.accs.map((acc) => {
      let sessions = 0;
      for (const t of this.sessions.values()) if (t.acc === acc && t.inOffice) sessions++;
      const info: SourceInfo = { label: acc.id, provider: 'copilot', path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.sessions.get(agentId);
    return t?.inOffice ? t.path : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.sessions.has(agentId) ? createCopilotTerminalParser() : undefined;
  }

  /** Waits for the reads of the start of the large files (tests). */
  idle(): Promise<void> {
    return this.prefixChain;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`copilot-poll:${errMsg(err)}`, tr('Copilot: read cycle failed: {0}', [errMsg(err)]));
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
    const keep = new Set<string>();
    for (const acc of this.accs) {
      this.watchDir(join(acc.dir, SESSION_STATE_DIR));
      if (boot || now - acc.scanAt >= RESCAN_MS) this.rescan(acc, now);
      const open = readOpenSessions(acc.dir);
      const candidates = new Set(acc.recent.keys());
      if (open) for (const id of open.keys()) candidates.add(id);
      for (const t of this.sessions.values()) if (t.acc === acc) candidates.add(t.sessionId);
      for (const id of candidates) {
        const key = `${acc.id}:${id}`;
        let t = this.sessions.get(key);
        if (!t) {
          t = this.newTracker(acc, id);
          this.sessions.set(key, t);
        }
        try {
          if (this.sync(t, open, now, boot)) keep.add(key);
        } catch (err) {
          log.warnOnce(`copilot-session:${key}:${errMsg(err)}`, tr('Copilot: session {0}: {1}', [key, errMsg(err)]));
          keep.add(key);
        }
      }
    }
    for (const [key, t] of [...this.sessions]) {
      if (keep.has(key)) continue;
      this.leave(t);
      this.unwatch(t);
      this.sessions.delete(key);
    }
  }

  /** Sessions whose events.jsonl changed within the quiet window (stat only; the files are opened later). */
  private rescan(acc: CopilotAccount, now: number): void {
    acc.scanAt = now;
    const recent = new Map<string, number>();
    for (const id of listSessionIds(acc.dir)) {
      // Only the checked path is stat-ed: a link out of the Copilot folder is never followed.
      const path = sessionFile(acc.dir, id, EVENTS_FILE);
      if (!path) continue;
      try {
        const mtime = statSync(path).mtimeMs;
        if (now - mtime <= QUIET_WINDOW_MS) recent.set(id, mtime);
      } catch {
        // folder without events.jsonl (yet): skipped
      }
    }
    acc.recent = recent;
    if (isCopilotHome(acc.dir)) delete acc.error;
    else acc.error = tr('session-state/ not found');
  }

  private newTracker(acc: CopilotAccount, sessionId: string): SessionTracker {
    return {
      key: `${acc.id}:${sessionId}`,
      acc,
      sessionId,
      state: createCopilotState(),
      workspace: {},
      backlog: [],
      inOffice: false,
      status: 'idle',
    };
  }

  /**
   * One cycle of a candidate session: reads what is new and decides whether it is (or stays) in the office. Returns
   * false when the tracker can be dropped (no events file, or no longer a candidate for presence).
   */
  private sync(t: SessionTracker, open: Map<string, number | undefined> | null, now: number, boot: boolean): boolean {
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false; // left the office (grace ended)
    this.pump(t, boot);
    if (!t.tail) {
      this.leave(t);
      return false;
    }
    const listed = !!open?.has(t.sessionId.toLowerCase());
    t.refreshedAt = listed ? open?.get(t.sessionId.toLowerCase()) : undefined;
    const last = t.lastWriteAt ?? 0;
    const present = !t.state.shutdown && (listed ? now - last <= STALE_OPEN_MS : now - last <= QUIET_WINDOW_MS);
    if (!present) {
      this.leave(t);
      // Still a candidate (listed or recent): the tracker stays, so the file is not reread from scratch every cycle.
      if (listed || now - last <= QUIET_WINDOW_MS) return true;
      // Neither: nothing more to follow until it changes again (the next rescan finds it).
      t.acc.recent.delete(t.sessionId);
      return false;
    }
    this.refreshStatus(t, now);
    if (!t.inOffice) this.enter(t, now);
    else this.statusToOffice(t);
    if (t.inOffice) this.opts.office.fillWorkingActivity(t.key);
    return true;
  }

  /** Start of the session: session.start, else the workspace.yaml created_at, else the first event read. */
  private startedAtOf(t: SessionTracker): number | undefined {
    return t.state.startedAt ?? t.workspace.createdAt ?? t.state.firstAt;
  }

  /** Room of the session: the workspace.yaml cwd, else the session.start one. */
  private cwdOf(t: SessionTracker): string | undefined {
    return t.workspace.cwd ?? t.state.cwd;
  }

  private enter(t: SessionTracker, now: number): void {
    if (!t.workspace.cwd) t.workspace = readWorkspace(t.acc.dir, t.sessionId);
    const cwd = this.cwdOf(t);
    if (!cwd) return;
    const office = this.opts.office;
    office.addMain({
      id: t.key,
      provider: 'copilot',
      account: t.acc.id,
      sessionId: t.sessionId,
      cwd,
      role: MAIN_ROLE,
      startedAt: this.startedAtOf(t) ?? now,
      status: t.status,
      waitingFor: t.waitingFor,
    });
    t.inOffice = office.has(t.key);
    if (!t.inOffice) return;
    // Reopened within the grace period: the status may have changed while it was away.
    office.setStatus(t.key, t.status, t.waitingFor);
    const backlog = t.backlog;
    t.backlog = [];
    for (const r of backlog) this.toOffice(t, r, false);
    this.applySummary(t);
  }

  private leave(t: SessionTracker): void {
    if (!t.inOffice) return;
    this.opts.office.closeMain(t.key);
    t.inOffice = false;
  }

  /** Status from the events, with the dead-turn and dead-prompt rules. */
  private refreshStatus(t: SessionTracker, now: number): void {
    const s = copilotStatus(t.state);
    let status: AgentStatus = s.status;
    const wrote = t.lastWriteAt ?? 0;
    if (status === 'working' && now - Math.max(wrote, t.state.statusAt) > WORKING_QUIET_MS) status = 'idle';
    // refreshedAt only adds activity newer than the last write (it moves on activity, it proves nothing alive).
    else if (status === 'waiting' && now - Math.max(wrote, t.refreshedAt ?? 0) > WAITING_QUIET_MS) status = 'idle';
    t.status = status;
    if (s.waitingFor && status === 'waiting') t.waitingFor = s.waitingFor;
    else delete t.waitingFor;
  }

  private statusToOffice(t: SessionTracker): void {
    if (t.inOffice) this.opts.office.setStatus(t.key, t.status, t.waitingFor);
  }

  // ---------------------------------------------------------------- events file

  /** Opens the events file the first time (end window) and reads whatever is new. */
  private pump(t: SessionTracker, boot: boolean): void {
    if (!t.tail) {
      const path = sessionFile(t.acc.dir, t.sessionId, EVENTS_FILE);
      if (path) this.load(t, path);
      return;
    }
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = t.tail.read();
      } catch (err) {
        log.warnOnce(`copilot-read:${t.key}`, tr('Copilot: unreadable events file for {0} ({1}).', [t.key, errMsg(err)]));
        return;
      }
      if (r.missing) {
        this.unwatch(t);
        delete t.tail;
        delete t.path;
        return;
      }
      t.lastWriteAt = t.tail.mtimeMs;
      if (r.reset) {
        this.load(t, t.tail.path);
        return;
      }
      for (const line of r.lines) {
        this.keepForReplay(t, line);
        this.apply(t, parseEventLine(t.state, line, { idPrefix: t.key, now: this.now() }), !boot);
      }
      if (r.lines.length) {
        this.followShutdown(t);
        this.refreshStatus(t, this.now());
        this.statusToOffice(t);
        this.applySummary(t);
      }
      if (!r.more) break;
    }
  }

  /** Reads the end window of the events file; the start of a large one goes in background. */
  private load(t: SessionTracker, path: string): void {
    this.unwatch(t);
    const tail = new FileTail(path);
    const start = tail.seekTail(this.tailBytes);
    t.tail = tail;
    t.path = path;
    t.state = createCopilotState();
    t.backlog = [];
    t.ended = false;
    delete t.prefixEnd;
    t.workspace = readWorkspace(t.acc.dir, t.sessionId);
    if (start > 0) t.replay = { lines: [], chars: 0 };
    else delete t.replay;
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      for (const line of r.lines) {
        this.keepForReplay(t, line);
        this.apply(t, parseEventLine(t.state, line, { idPrefix: t.key, now: this.now() }), false);
      }
      if (!r.more) break;
    }
    t.lastWriteAt = tail.mtimeMs;
    this.refreshStatus(t, this.now());
    if (t.inOffice) {
      const backlog = t.backlog;
      t.backlog = [];
      for (const r of backlog) this.toOffice(t, r, false);
      this.statusToOffice(t);
    }
    this.applySummary(t);
    if (t.state.shutdown) {
      // Ended: no watch and nothing kept; the start is read only if the session is resumed (followShutdown).
      t.ended = true;
      t.backlog = [];
      delete t.replay;
      if (start > 0) t.prefixEnd = start;
      return;
    }
    this.watchFile(t, path);
    if (start > 0) this.queuePrefix(t, path, start);
  }

  /**
   * After session.shutdown: closes the fs.watch, drops the backlog and the replay and puts off the read of the start
   * (the poll's cheap check of the file stays). New events after it (resumed): the watch and the start come back.
   */
  private followShutdown(t: SessionTracker): void {
    const ended = t.state.shutdown;
    if (ended === !!t.ended) return;
    t.ended = ended;
    if (ended) {
      this.unwatch(t);
      t.backlog = [];
      delete t.replay;
      return;
    }
    if (!t.path) return;
    this.watchFile(t, t.path);
    const end = t.prefixEnd;
    delete t.prefixEnd;
    if (end !== undefined) this.queuePrefix(t, t.path, end);
  }

  /** Keeps a line for the status replay while the start of the file is still being read. */
  private keepForReplay(t: SessionTracker, line: string): void {
    const replay = t.replay;
    if (!replay) return;
    replay.chars += line.length;
    if (replay.chars > REPLAY_MAX_CHARS) delete t.replay; // too much: the status from the window stays
    else replay.lines.push(line);
  }

  /** Applies a line result: live, it goes straight to the office; in the initial load, it stays in the backlog. */
  private apply(t: SessionTracker, r: CopilotLineResult, live: boolean): void {
    if (!r.activities.length) return;
    if (!live || !t.inOffice) {
      if (t.state.shutdown) return; // shut down: nothing to keep for later
      t.backlog.push(r);
      if (t.backlog.length > BACKLOG_MAX) t.backlog.splice(0, t.backlog.length - BACKLOG_MAX);
      return;
    }
    this.toOffice(t, r, true);
  }

  private toOffice(t: SessionTracker, r: CopilotLineResult, live: boolean): void {
    for (const a of r.activities) this.opts.office.addActivity(t.key, a.activity, a.current, { feed: live });
  }

  private applySummary(t: SessionTracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    const summary: TranscriptSummary = { tasks: [], stats: { ...s.stats } };
    if (s.title) summary.title = s.title;
    if (s.model) summary.model = s.model;
    if (s.firstAt !== undefined) summary.firstAt = s.firstAt;
    if (s.lastAt !== undefined) summary.lastAt = s.lastAt;
    const startedAt = this.startedAtOf(t);
    if (startedAt !== undefined) summary.startedAt = startedAt;
    this.opts.office.applyTranscript(t.key, summary);
  }

  /**
   * Start of a large events file (before the window read): numbers, title, start, model and the long timeline. The
   * first prompt and the start come from the start of the file; the status is derived again from the whole file, in
   * order (the start, then every line read since), so nothing older overrides something newer.
   */
  private queuePrefix(t: SessionTracker, path: string, end: number): void {
    const state = t.state;
    this.prefixChain = this.prefixChain
      .then(async () => {
        if (this.stopped || this.sessions.get(t.key) !== t || t.state !== state) return;
        if (state.shutdown) {
          // Shut down before its turn came: read only if the session is resumed.
          t.prefixEnd = end;
          return;
        }
        const prefix = await scanPrefix(path, end, t.key, PREFIX_HISTORY);
        if (this.sessions.get(t.key) !== t || t.state !== state) return;
        const replay = t.replay;
        delete t.replay;
        state.stats.toolCalls += prefix.state.stats.toolCalls;
        state.stats.tokensIn += prefix.state.stats.tokensIn;
        state.stats.tokensOut += prefix.state.stats.tokensOut;
        if (prefix.state.title !== undefined) state.title = prefix.state.title;
        state.model ??= prefix.state.model;
        state.cwd ??= prefix.state.cwd;
        if (prefix.state.startedAt !== undefined && (state.startedAt === undefined || prefix.state.startedAt < state.startedAt)) state.startedAt = prefix.state.startedAt;
        if (prefix.state.firstAt !== undefined && (state.firstAt === undefined || prefix.state.firstAt < state.firstAt)) state.firstAt = prefix.state.firstAt;
        if (replay) {
          const full = prefix.state;
          const ctx = { idPrefix: t.key, now: this.now(), activities: false };
          for (const line of replay.lines) parseEventLine(full, line, ctx);
          state.busy = full.busy;
          state.finalAnswer = full.finalAnswer;
          state.statusAt = full.statusAt;
          state.permissions = full.permissions;
          state.tools = full.tools;
          state.shutdown = full.shutdown;
          this.refreshStatus(t, this.now());
        }
        // Like the boot: what was already true before the window is not news (no notice).
        const office = this.opts.office;
        office.beginBoot();
        try {
          this.statusToOffice(t);
          this.applySummary(t);
        } finally {
          office.endBoot();
        }
        if (t.inOffice) office.mergeHistory(t.key, prefix.activities);
      })
      .catch((err) => log.warnOnce(`copilot-prefix:${path}`, tr("Copilot: couldn't read the start of an events file ({0}).", [errMsg(err)])));
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
      // not supported (or the folder doesn't exist yet): polling covers it
    }
  }

  private watchFile(t: SessionTracker, path: string): void {
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

  private unwatch(t: SessionTracker): void {
    t.watcher?.close();
    delete t.watcher;
  }
}

/**
 * Reads as a stream (without blocking the event loop) the bytes [0, end) of an events file: the numbers, the title
 * and the last `keep` activities before the window read when the session opens.
 */
export async function scanPrefix(path: string, end: number, idPrefix: string, keep: number): Promise<{ state: CopilotState; activities: Activity[] }> {
  const state = createCopilotState();
  let activities: Activity[] = [];
  if (end <= 0) return { state, activities };
  const ctx = { idPrefix, now: Date.now(), activities: keep > 0 };
  const take = (line: string) => {
    const r = parseEventLine(state, line, ctx);
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
