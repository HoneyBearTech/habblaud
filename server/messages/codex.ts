// Messages through the office to the Codex sessions: `codex queue --thread <threadId> --message <texto>` puts the
// message in the thread's queue (it goes in when the session becomes idle; the thread's owner checks the queue every
// ~10 s; the turn it opens carries turn_trigger "queue"). The command needs to run on the Mac (host), with the
// account's CODEX_HOME:
// - Node mode: the server itself runs the command (binary HABBLAUD_CODEX_BIN or `codex` from the PATH);
// - Docker: the host helper (scripts/codex-bridge.ts, npm run codex:bridge) fetches the messages at
//   POST /api/codex/bridge/poll, runs the same command and confirms at POST /api/codex/bridge/ack.
// No shell (execFile), with a deadline, and never with -c, --enable, --disable or --no-daemon (they would change the
// configuration or the session's server). Return 0 ("Queued message <id> for thread <thread>.") = it got into the
// queue — even if nobody has the thread open right now; another return = it failed, and the 1st line of stderr says
// why ("Error: ... no rollout found for thread id ..."). If Codex's shared server (daemon) is not up, the command
// itself starts it.
// Pure Node and no dependencies: it is also imported by the host helper (via tsx).
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { tr } from '../../shared/i18n';

/** Deadline of a `codex queue`. */
export const QUEUE_TIMEOUT_MS = 20_000;
/** Codex thread id (UUID; `codex queue --thread` would also accept names, but Habblaud only sends ids). */
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_MAX = 300;

export interface CodexQueueJob {
  /** The account's CODEX_HOME folder (host path). */
  codexHome: string;
  /** Thread id (AgentInfo.sessionId of the Codex agent). */
  thread: string;
  /** The text as it was typed. */
  text: string;
}

export type CodexQueueResult = { ok: true } | { ok: false; error: string };
export type CodexQueueRunner = (job: CodexQueueJob) => Promise<CodexQueueResult>;

function canExecute(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Name of the binary on the PATH. On Windows, only `codex.exe`: the `codex` without extension and the `codex.cmd` that
 * npm puts next to it are scripts, and execFile (no shell) doesn't run them.
 */
export const CODEX_BIN_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';

/** Codex binary: HABBLAUD_CODEX_BIN (path of an executable) or `codex` on the PATH. undefined = not found. */
export function findCodexBin(env: NodeJS.ProcessEnv, isExecutable: (p: string) => boolean = canExecute): string | undefined {
  const explicit = env.HABBLAUD_CODEX_BIN?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, CODEX_BIN_NAME);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

/** Arguments of `codex queue` (with "=": a text that starts with "-" never becomes an option). */
export function queueArgs(thread: string, text: string): string[] {
  return ['queue', `--thread=${thread}`, `--message=${text}`];
}

/** First non-empty line (Codex writes the error as "Error: ..."), cut. */
export function firstLine(s: string | undefined): string | undefined {
  const line = (s ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

/** Runs `codex queue` with the given binary. Never rejects: a failure becomes `{ok: false, error}`. */
export function createCodexQueueRunner(bin: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): CodexQueueRunner {
  const timeoutMs = opts.timeoutMs ?? QUEUE_TIMEOUT_MS;
  return (job) =>
    new Promise<CodexQueueResult>((done) => {
      if (!THREAD_ID.test(job.thread)) return done({ ok: false, error: tr('invalid Codex thread id') });
      if (!isAbsolute(job.codexHome)) return done({ ok: false, error: tr('invalid Codex account folder') });
      const env = { ...(opts.env ?? process.env), CODEX_HOME: job.codexHome };
      try {
        execFile(bin, queueArgs(job.thread, job.text), { env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' }, (err, _stdout, stderr) => {
          if (!err) return done({ ok: true });
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.killed) return done({ ok: false, error: tr("codex queue didn't respond within {0} s (the message may have been queued anyway)", [Math.round(timeoutMs / 1_000)]) });
          if (e.code === 'ENOENT' || e.code === 'EACCES') return done({ ok: false, error: tr("couldn't run Codex ({0})", [bin]) });
          done({ ok: false, error: firstLine(stderr) ?? tr('codex queue failed (code {0})', [String(e.code ?? '?')]) });
        });
      } catch {
        // Argument that can't be passed to a process (e.g.: NUL character in the text).
        done({ ok: false, error: tr("the message has characters that can't be sent to Codex") });
      }
    });
}
