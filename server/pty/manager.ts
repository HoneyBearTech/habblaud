// Interactive terminal: Habblaud opens Claude Code in a pseudo-terminal (node-pty) and the browser shows and
// controls that terminal (xterm.js). Output via SSE on GET /api/pty/:id/stream; input, resizing and
// ending via POST (routes in http/pty.ts).
//
// Three uses: a new session in a folder; "taking over" a session open in another terminal (the process there is
// ended and the same conversation continues here with `claude --resume`); and ending an agent, whether it is here
// or in another terminal (only processes that Claude Code's session registry confirms as a session and whose start
// and executable match the registry: pty/procinfo.ts).
//
// Security: whoever controls one of these terminals runs commands on the machine. The feature is opt-in
// (HABBLAUD_PTY=1), the routes only accept connections from the computer itself (see http/pty.ts) and it stays off
// in Docker.
import { chmodSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { PtyInfo, PtyStatus } from '../../shared/types';
import { frame } from '../http/sse';
import { errMsg, log } from '../log';
import { pidAlive } from '../sources/registry';
import { readProcInfo, sameProcess, type ProcInfo, type RegisteredProc } from './procinfo';
import { killWithConsoleReset } from './winkill';
import { tr } from '../../shared/i18n';
import { isExecutableFile } from '../claude-bin';

export { claudeBinFrom, findExecutable, isExecutableFile } from '../claude-bin';

/** What the manager uses from node-pty (lets the tests swap it). */
export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnPty = (file: string, args: string[], opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) => PtyProcess;

export interface PtyAccount {
  id: string;
  /** Configuration folder of the account (becomes CLAUDE_CONFIG_DIR, except the default one). */
  dir: string;
  isDefault: boolean;
}

/** What the manager needs to know about a main agent to end it or take it over. */
export interface PtyAgentRef {
  id: string;
  kind: 'main' | 'sub';
  account: string;
  sessionId: string;
  cwd?: string;
}

/**
 * Screen of a terminal on the server: receives the output and returns, for whoever connects later (or switches
 * tabs), a sequence that rebuilds the current screen with the modes the program turned on (bracketed paste,
 * application keys, alternate screen). `write` may process later: the callback tells when that chunk went in.
 */
export interface PtyScreen {
  write(data: string, done?: () => void): void;
  resize(cols: number, rows: number): void;
  serialize(): string;
  dispose(): void;
}

export type ScreenFactory = (cols: number, rows: number) => PtyScreen;

export interface PtyManagerOptions {
  spawn: SpawnPty | null;
  /** Why the feature is off (when `spawn` is null). */
  disabledReason?: string;
  claudeBin: string;
  accounts: () => PtyAccount[];
  agent: (id: string) => PtyAgentRef | undefined;
  onChange: () => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Ends an outside process (tests). Default: on Windows, ends it and clears its terminal modes (pty/winkill.ts,
   * which checks the exact start again); on the others, SIGTERM (Claude Code exits and cleans up by itself).
   */
  killPid?: (pid: number, proc: ProcInfo) => void | Promise<void>;
  /**
* Ends by force when the process does not exit in time on a takeover (default: SIGKILL; on Windows,
* TerminateProcess).
*/
  forceKill?: (pid: number) => void;
  /** Start and executable of a live process (default: pty/procinfo.ts). */
  procInfo?: (pid: number) => Promise<ProcInfo | undefined>;
  /** Reads `<conta>/sessions/<pid>.json` (tests). */
  readSession?: (accountDir: string, pid: number) => unknown;
  /** Screen of each terminal, replayed for whoever connects (default: only the raw output; see pty/screen.ts). */
  createScreen?: ScreenFactory;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Raw output kept per terminal when @xterm/headless is not there (see rawScreen). */
const MAX_SCROLLBACK = 512 * 1024;
/** Ended terminals stay in the list for a while, so the final screen can still be seen. */
const EXITED_KEEP_MS = 10 * 60_000;
export const MAX_PTYS = 12;
/** How long to wait for the outside process to exit before resuming the session here (then ends it by force). */
const TAKEOVER_WAIT_MS = 5_000;
/** After ending by force: how much longer to wait. */
const FORCE_WAIT_MS = 3_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Main agent id: "<account>:<pid>". */
const MAIN_ID = /^(.+):(\d+)$/;

/**
 * Variables that Claude Code puts in the environment of its own tools. If Habblaud was started from inside
 * a session, the Claude opened here would think it is a child session (and would turn off the transcript).
 */
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'AI_AGENT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
];

/**
 * Without @xterm/headless: keeps the raw output, cut at the start of a line (never in the middle of an escape
 * sequence). The modes turned on back at the start may be lost on replay.
 */
export function rawScreen(): PtyScreen {
  let buffer = '';
  return {
    write(data, done) {
      buffer += data;
      if (buffer.length > MAX_SCROLLBACK) {
        const cut = buffer.indexOf('\n', buffer.length - MAX_SCROLLBACK);
        buffer = cut === -1 ? '' : buffer.slice(cut + 1);
      }
      done?.();
    },
    resize() {},
    serialize: () => buffer,
    dispose() {
      buffer = '';
    },
  };
}

interface Pty {
  info: PtyInfo;
  proc: PtyProcess;
  screen: PtyScreen;
  clients: Set<ServerResponse>;
  /** Connecting: they keep the new output in a queue until the stored screen is ready. */
  pending: Map<ServerResponse, string[]>;
}

/** Session open in another terminal, checked: the PID and what the system says about it. */
interface ExternalProc {
  pid: number;
  proc: ProcInfo;
}

/** What a new session needs, already validated (folder, account and size). */
interface SpawnPlan {
  cwd: string;
  account: PtyAccount;
  cols: number;
  rows: number;
}

export class PtyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PtyManager {
  private ptys = new Map<string, Pty>();
  private seq = 0;
  /** "Take over" in progress per agent: a double click (or two tabs) gets the same result. */
  private takeovers = new Map<string, Promise<PtyInfo>>();
  private readonly now: () => number;
  private readonly killPid: (pid: number, proc: ProcInfo) => void | Promise<void>;
  private readonly forceKill: (pid: number) => void;
  private readonly procInfo: (pid: number) => Promise<ProcInfo | undefined>;
  private readonly readSession: (accountDir: string, pid: number) => unknown;
  private readonly createScreen: ScreenFactory;
  private readonly isAlive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PtyManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.procInfo = opts.procInfo ?? ((pid) => readProcInfo(pid));
    this.killPid =
      opts.killPid ??
      (process.platform === 'win32'
        ? (pid, proc) => killWithConsoleReset(pid, proc.fileTime ?? '', () => this.stillSame(pid, proc))
        : (pid) => void process.kill(pid, 'SIGTERM'));
    this.forceKill = opts.forceKill ?? ((pid) => void process.kill(pid, 'SIGKILL'));
    this.readSession = opts.readSession ?? ((dir, pid) => JSON.parse(readFileSync(join(dir, 'sessions', `${pid}.json`), 'utf8')));
    this.createScreen = opts.createScreen ?? (() => rawScreen());
    this.isAlive = opts.isAlive ?? pidAlive;
    this.sleep = opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  }

  status(): PtyStatus {
    return this.opts.spawn ? { enabled: true } : { enabled: false, reason: this.opts.disabledReason ?? tr('unavailable') };
  }

  list(): PtyInfo[] {
    const now = this.now();
    for (const [id, t] of this.ptys) {
      if (t.info.exitedAt !== undefined && now - t.info.exitedAt > EXITED_KEEP_MS) this.drop(id);
    }
    return [...this.ptys.values()].map((t) => ({ ...t.info }));
  }

  /** Opens a new Claude Code session in the folder (absolute `cwd`), on the requested account (or the default one). */
  create(p: { cwd: unknown; account?: unknown; cols?: unknown; rows?: unknown }): PtyInfo {
    return this.spawn(this.plan(p, this.takeovers.size));
  }

  /**
   * Ends a main agent. Open here: closes the pty. Open in another terminal: ends the process, but only
   * if the account's session registry confirms that that PID is that Claude Code session (and the live process
   * with that PID started when the registry says and is Claude Code).
   */
  async stop(agentId: string): Promise<void> {
    const own = this.byAgent(agentId);
    if (own) {
      this.kill(own);
      return;
    }
    const ext = await this.external(agentId);
    try {
      await this.killPid(ext.pid, ext.proc);
    } catch (err) {
      throw new PtyError(500, tr("couldn't end the session: {0}", [errMsg(err)]));
    }
    log.info(tr('Agent {0} ended from the office.', [agentId]));
  }

  /**
   * Takes over a session open in another terminal: ends the process there, waits for it to exit and continues the
   * same conversation here (`claude --resume <session>`, in the original folder and account). What can prevent the new
   * session (folder, account, limit) is checked before ending the one there; repeated requests wait for the first.
   */
  takeover(agentId: string, size: { cols?: unknown; rows?: unknown } = {}): Promise<PtyInfo> {
    const pending = this.takeovers.get(agentId);
    if (pending) return pending;
    const run = this.doTakeover(agentId, size).finally(() => this.takeovers.delete(agentId));
    this.takeovers.set(agentId, run);
    return run;
  }

  private async doTakeover(agentId: string, size: { cols?: unknown; rows?: unknown }): Promise<PtyInfo> {
    // One tick: the request is already in this.takeovers (it counts in the limit below as "this" takeover).
    await Promise.resolve();
    if (!this.opts.spawn) throw new PtyError(503, tr('terminal disabled: {0}', [this.opts.disabledReason ?? tr('unavailable')]));
    const own = this.byAgent(agentId);
    if (own) return { ...own.info };
    const agent = this.mainAgent(agentId);
    if (!SESSION_ID.test(agent.sessionId)) throw new PtyError(409, tr('session has no valid id to resume'));
    if (!agent.cwd) throw new PtyError(409, tr("I don't know this session's folder"));
    // The other takeovers in progress already have a spot promised.
    const plan = this.plan({ cwd: agent.cwd, account: agent.account, cols: size.cols, rows: size.rows }, this.takeovers.size - 1);
    const ext = await this.external(agentId);
    try {
      await this.killPid(ext.pid, ext.proc);
    } catch (err) {
      throw new PtyError(500, tr("couldn't end the session in the other terminal: {0}", [errMsg(err)]));
    }
    if (!(await this.waitExit(ext.pid, TAKEOVER_WAIT_MS))) {
      // Did not exit in time: ends it by force (if it is still the same process) and waits a little longer.
      log.warn(tr("Agent {0} didn't exit within {1} s: forcing it to close.", [agentId, TAKEOVER_WAIT_MS / 1000]));
      try {
        if (await this.stillSame(ext.pid, ext.proc)) this.forceKill(ext.pid);
      } catch (err) {
        log.warn(tr('Failed to force-kill process {0}: {1}', [ext.pid, errMsg(err)]));
      }
      if (!(await this.waitExit(ext.pid, FORCE_WAIT_MS))) {
        throw new PtyError(500, tr("the session in the other terminal didn't close, even when forced; it's still open there"));
      }
    }
    let info: PtyInfo;
    try {
      info = this.spawn(plan, { resume: agent.sessionId, from: agentId });
    } catch (err) {
      // The session there has already been ended: say how to continue the conversation.
      throw new PtyError(500, tr("the session was ended in the other terminal, but didn't open here ({0}); to continue: claude --resume {1}", [errMsg(err), agent.sessionId]));
    }
    log.info(tr('Agent {0} taken over by the office (session {1}).', [agentId, agent.sessionId]));
    return info;
  }

  /** Connects an SSE client: the current screen first, then the live output. */
  attach(id: string, req: IncomingMessage, res: ServerResponse): void {
    const pty = this.get(id);
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    // The output that arrives while the screen finishes processing what came before goes to this client's queue.
    const queue: string[] = [];
    pty.pending.set(res, queue);
    const drop = () => {
      pty.pending.delete(res);
      pty.clients.delete(res);
    };
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    pty.screen.write('', () => {
      if (!pty.pending.delete(res) || res.writableEnded) return;
      res.write(frame('reset', pty.screen.serialize()));
      for (const data of queue) res.write(frame('data', data));
      if (pty.info.exitedAt !== undefined) res.write(frame('exit', { code: pty.info.exitCode ?? 0 }));
      pty.clients.add(res);
    });
  }

  input(id: string, data: unknown): void {
    if (typeof data !== 'string' || data.length > 64 * 1024) throw new PtyError(400, tr('invalid input'));
    this.running(id).proc.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    const pty = this.running(id);
    const c = clampInt(cols, 20, 400, 100);
    const r = clampInt(rows, 5, 200, 30);
    pty.proc.resize(c, r);
    pty.screen.resize(c, r);
  }

  /** Ends the process (still running) or removes it from the list (already ended). */
  close(id: string): void {
    const pty = this.get(id);
    if (pty.info.exitedAt === undefined) this.kill(pty);
    else {
      this.drop(id);
      this.opts.onChange();
    }
  }

  stopAll(): void {
    for (const t of this.ptys.values()) {
      for (const c of t.clients) c.end();
      for (const c of t.pending.keys()) c.end();
      t.screen.dispose();
      if (t.info.exitedAt === undefined) {
        try {
          t.proc.kill();
        } catch {
          // shutting down the server: nothing to do
        }
      }
    }
    this.ptys.clear();
  }

  /** Validates the request for a new session (`reserved`: slots already promised to takeovers in progress). */
  private plan(p: { cwd: unknown; account?: unknown; cols?: unknown; rows?: unknown }, reserved = 0): SpawnPlan {
    if (!this.opts.spawn) throw new PtyError(503, tr('terminal disabled: {0}', [this.opts.disabledReason ?? tr('unavailable')]));
    // Before anything else (the "take over" ends the session over there after this point): a claude that doesn't run
    // would open a terminal that exits right away.
    if (!isExecutableFile(this.opts.claudeBin)) throw new PtyError(503, tr("the Claude Code executable doesn't run: {0} (check HABBLAUD_CLAUDE_BIN)", [this.opts.claudeBin]));
    if (typeof p.cwd !== 'string' || !isAbsolute(p.cwd)) throw new PtyError(400, tr('provide the project folder (absolute path)'));
    const cwd = resolve(p.cwd);
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      // handled below
    }
    if (!isDir) throw new PtyError(400, tr('folder not found: {0}', [cwd]));
    const accounts = this.opts.accounts();
    const account = typeof p.account === 'string' ? accounts.find((a) => a.id === p.account) : (accounts.find((a) => a.isDefault) ?? accounts[0]);
    if (!account) throw new PtyError(400, tr('unknown account'));
    const running = [...this.ptys.values()].filter((t) => t.info.exitedAt === undefined).length;
    if (running + Math.max(0, reserved) >= MAX_PTYS) throw new PtyError(429, tr('limit of {0} open terminals', [MAX_PTYS]));
    return { cwd, account, cols: clampInt(p.cols, 20, 400, 100), rows: clampInt(p.rows, 5, 200, 30) };
  }

  private spawn(plan: SpawnPlan, p: { resume?: string; from?: string } = {}): PtyInfo {
    const spawn = this.opts.spawn;
    if (!spawn) throw new PtyError(503, tr('terminal disabled: {0}', [this.opts.disabledReason ?? tr('unavailable')]));
    const { cwd, account, cols, rows } = plan;
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const k of INHERITED_SESSION_VARS) delete env[k];
    if (account.isDefault) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = account.dir;

    let proc: PtyProcess;
    try {
      const args = p.resume ? ['--resume', p.resume] : [];
      proc = spawn(this.opts.claudeBin, args, { cwd, cols, rows, env });
    } catch (err) {
      throw new PtyError(500, tr("couldn't open Claude Code: {0}", [errMsg(err)]));
    }
    const id = `p${++this.seq}-${proc.pid}`;
    const info: PtyInfo = { id, pid: proc.pid, cwd, account: account.id, agentId: `${account.id}:${proc.pid}`, startedAt: this.now() };
    if (p.resume) info.resumed = p.resume;
    if (p.from) info.fromAgent = p.from;
    const pty: Pty = { info, proc, screen: this.createScreen(cols, rows), clients: new Set(), pending: new Map() };
    this.ptys.set(id, pty);
    proc.onData((data) => {
      pty.screen.write(data);
      for (const queue of pty.pending.values()) queue.push(data);
      this.broadcast(pty, 'data', data);
    });
    proc.onExit(({ exitCode }) => {
      pty.info.exitedAt = this.now();
      pty.info.exitCode = exitCode;
      this.broadcast(pty, 'exit', { code: exitCode });
      this.opts.onChange();
    });
    log.info(p.resume ? tr('Terminal {0} opened in {1} (account {2}, resuming {3}).', [id, cwd, account.id, p.resume]) : tr('Terminal {0} opened in {1} (account {2}).', [id, cwd, account.id]));
    this.opts.onChange();
    return { ...info };
  }

  private byAgent(agentId: string): Pty | undefined {
    for (const t of this.ptys.values()) if (t.info.agentId === agentId && t.info.exitedAt === undefined) return t;
    return undefined;
  }

  private mainAgent(agentId: string): PtyAgentRef {
    const agent = this.opts.agent(agentId);
    if (!agent) throw new PtyError(404, tr('agent not found'));
    if (agent.kind !== 'main') throw new PtyError(400, tr("only a session's main agent can be ended or taken over"));
    return agent;
  }

  /**
   * Main agent opened outside Habblaud, confirmed by the account's session record (same session) and by the
   * system (the process with this PID started when the record says and is Claude Code).
   */
  private async external(agentId: string): Promise<ExternalProc> {
    const agent = this.mainAgent(agentId);
    const m = MAIN_ID.exec(agent.id);
    const pid = m ? Number(m[2]) : NaN;
    if (!m || m[1] !== agent.account || !Number.isSafeInteger(pid) || pid <= 0) throw new PtyError(400, tr('agent has no known process'));
    const account = this.opts.accounts().find((a) => a.id === agent.account);
    if (!account) throw new PtyError(400, tr('unknown account'));
    let registered: unknown;
    try {
      registered = this.readSession(account.dir, pid);
    } catch {
      throw new PtyError(409, tr('the session is no longer open'));
    }
    const r = (registered ?? {}) as { sessionId?: unknown; startedAt?: unknown; procStart?: unknown };
    if (r.sessionId !== agent.sessionId) throw new PtyError(409, tr('the process no longer belongs to this session'));
    if (!this.isAlive(pid)) throw new PtyError(409, tr('the session is no longer open'));
    const reg: RegisteredProc = {
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : undefined,
      procStart: typeof r.procStart === 'string' ? r.procStart : undefined,
    };
    const proc = await this.procInfo(pid);
    if (!proc) throw new PtyError(409, tr("couldn't check this session's process (it may have already ended)"));
    if (!sameProcess(reg, proc)) throw new PtyError(409, tr('process {0} is no longer this Claude Code session (stale record?)', [pid]));
    return { pid, proc };
  }

  /** Is the process `pid` still the same as `proc` (alive, same executable and same start)? */
  private async stillSame(pid: number, proc: ProcInfo): Promise<boolean> {
    if (!this.isAlive(pid)) return false;
    const now = await this.procInfo(pid);
    if (!now || now.name !== proc.name) return false;
    return proc.fileTime && now.fileTime ? now.fileTime === proc.fileTime : Math.abs(now.startMs - proc.startMs) < 1_000;
  }

  /** Waits for `pid` to exit (true) or for the time to run out (false). */
  private async waitExit(pid: number, ms: number): Promise<boolean> {
    for (let waited = 0; this.isAlive(pid) && waited < ms; waited += 100) await this.sleep(100);
    return !this.isAlive(pid);
  }

  private kill(pty: Pty): void {
    try {
      pty.proc.kill();
    } catch (err) {
      log.warn(tr('Failed to close terminal {0}: {1}', [pty.info.id, errMsg(err)]));
    }
  }

  private get(id: string): Pty {
    const pty = this.ptys.get(id);
    if (!pty) throw new PtyError(404, tr('terminal not found'));
    return pty;
  }

  private running(id: string): Pty {
    const pty = this.get(id);
    if (pty.info.exitedAt !== undefined) throw new PtyError(409, tr('the terminal has already been closed'));
    return pty;
  }

  private drop(id: string): void {
    const t = this.ptys.get(id);
    if (!t) return;
    for (const c of t.clients) c.end();
    for (const c of t.pending.keys()) c.end();
    t.screen.dispose();
    this.ptys.delete(id);
  }

  private broadcast(pty: Pty, event: string, data: unknown): void {
    const f = frame(event, data);
    for (const c of pty.clients) c.write(f);
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Loads node-pty (optional dependency) and checks that it opens a terminal. Returns null + reason if it can't:
 * without this, "Take over" would end the session over there and only then find out it can't open the one here.
 */
export async function loadPty(): Promise<{ spawn: SpawnPty | null; reason?: string }> {
  let ptySpawn: ((file: string, args: string[], o: Record<string, unknown>) => PtyProcess) | undefined;
  try {
    const mod = (await import('node-pty')) as unknown as {
      spawn?: (file: string, args: string[], o: Record<string, unknown>) => PtyProcess;
      default?: { spawn: (file: string, args: string[], o: Record<string, unknown>) => PtyProcess };
    };
    ptySpawn = mod.spawn ?? mod.default?.spawn;
  } catch (err) {
    return { spawn: null, reason: tr('node-pty not installed ({0})', [errMsg(err)]) };
  }
  if (!ptySpawn) return { spawn: null, reason: tr('node-pty has no spawn()') };
  const nativeSpawn = ptySpawn;
  const spawn: SpawnPty = (file, args, o) => nativeSpawn(file, args, { name: 'xterm-256color', cwd: o.cwd, cols: o.cols, rows: o.rows, env: o.env });
  // On Windows there is no spawn-helper; the spawn test was designed for macOS and Linux.
  if (process.platform === 'win32') return { spawn };
  const dir = nodePtyDir();
  if (dir) fixSpawnHelper(dir);
  const problem = await spawnProblem(spawn);
  return problem ? { spawn: null, reason: problem } : { spawn };
}

/** Folder of the node-pty package (undefined if it can't be found). */
function nodePtyDir(): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return undefined;
  }
}

/**
 * node-pty 1.1.0 publishes the macOS `spawn-helper` (prebuilds/darwin-*) without execute permission, and no install
 * script gives it back: without it, every terminal fails with "posix_spawnp failed". Gives the permission back in the
 * folders where node-pty looks for the native binary (the spawn-helper used is the one next to it).
 */
export function fixSpawnHelper(ptyDir: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): void {
  for (const sub of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
    const file = join(ptyDir, sub, 'spawn-helper');
    try {
      const mode = statSync(file).mode;
      if (!(mode & 0o100)) chmodSync(file, (mode & 0o777) | 0o111);
    } catch {
      // doesn't exist (or couldn't be changed): the spawn test tells whether the terminal opens
    }
  }
}

/** Opens a test terminal (Node itself, which exits right away): null if it worked, otherwise the reason. */
export function spawnProblem(spawn: SpawnPty, timeoutMs = 5_000): Promise<string | null> {
  let proc: PtyProcess;
  try {
    proc = spawn(process.execPath, ['-e', ''], { cwd: process.cwd(), cols: 80, rows: 24, env: process.env });
  } catch (err) {
    return Promise.resolve(tr("node-pty can't open terminals ({0})", [errMsg(err)]));
  }
  return new Promise((ok) => {
    // It opened and didn't exit in time: the spawn works, which is what matters here.
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      ok(null);
    }, timeoutMs);
    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      ok(exitCode === 0 ? null : tr('node-pty opened the test terminal, but it exited with code {0}', [exitCode]));
    });
  });
}
