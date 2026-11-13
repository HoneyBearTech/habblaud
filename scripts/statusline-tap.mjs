#!/usr/bin/env node
// Habblaud statusline tap: captures the plan usage (5h and weekly) WITHOUT reading credentials.
//
// Claude Code sends the statusline command, through stdin, a JSON with `rate_limits`
// ({five_hour:{used_percentage, resets_at}, seven_day:{...}}, resets_at in seconds). This script
// sits "in front of" the original statusline:
//
//   node /path/to/habblaud/scripts/statusline-tap.mjs -- <original statusline command>
//
// 1. reads all of stdin;
// 2. if there are rate_limits, writes <HABBLAUD_USAGE_DIR or ~/.habblaud/usage>/<account folder>.json with
//    ONLY {accountId, configDir, fetchedAt, five_hour, seven_day} (nothing else from stdin, for privacy);
// 3. runs the original command with the SAME stdin, inheriting stdout/stderr, and exits with its code (in the shell
//    in which Claude Code would run it: see originalShell).
//    Without an original command, prints nothing.
//
// Rules: plain Node and no dependencies; any failure in the capture is ignored silently — the
// statusline can never break or get slow because of Habblaud. Automatic installation
// (with a backup of settings.json): npm run usage:install.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Identical values written less than this long ago are not rewritten. */
const MIN_REWRITE_MS = 10_000;

/** Original command: everything after `--` (the installer puts in single quotes whatever is not trivial). */
export function originalCommand(argv) {
  const i = argv.indexOf('--');
  const rest = i >= 0 ? argv.slice(i + 1) : argv;
  return rest.join(' ').trim();
}

/** Account config dir: from transcript_path (the part before "/projects/"), CLAUDE_CONFIG_DIR or ~/.claude. */
export function configDirOf(input, env = process.env, home = env.HOME || homedir()) {
  const tp = typeof input?.transcript_path === 'string' ? input.transcript_path : '';
  const at = tp.lastIndexOf('/projects/');
  if (at > 0) return resolve(tp.slice(0, at));
  const fromEnv = (env.CLAUDE_CONFIG_DIR ?? '').split(',')[0].trim();
  if (fromEnv) return resolve(fromEnv.replace(/^~(?=\/|$)/, home));
  return join(home, '.claude');
}

function percent(w) {
  if (!w || typeof w !== 'object') return undefined;
  const raw = w.used_percentage ?? w.utilization ?? w.used_percent;
  const n = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined;
}

function windowOf(w) {
  const utilization = percent(w);
  if (utilization === undefined) return undefined;
  const r = w.resets_at;
  const resets = typeof r === 'number' && Number.isFinite(r) ? r : typeof r === 'string' && r.trim() ? r.trim() : undefined;
  return resets === undefined ? { utilization } : { utilization, resets_at: resets };
}

/** Record written (or undefined, if the JSON has no usable rate_limits). */
export function usageRecord(input, now, env = process.env, home = env.HOME || homedir()) {
  const rl = input && typeof input === 'object' ? input.rate_limits : undefined;
  if (!rl || typeof rl !== 'object') return undefined;
  const five = windowOf(rl.five_hour);
  const week = windowOf(rl.seven_day);
  if (!five && !week) return undefined;
  const configDir = configDirOf(input, env, home);
  const rec = { accountId: basename(configDir), configDir, fetchedAt: now };
  if (five) rec.five_hour = five;
  if (week) rec.seven_day = week;
  return rec;
}

export function usageDirOf(env = process.env, home = env.HOME || homedir()) {
  const d = (env.HABBLAUD_USAGE_DIR ?? '').trim();
  return d ? resolve(d.replace(/^~(?=\/|$)/, home)) : join(home, '.habblaud', 'usage');
}

/** Writes atomically (tmp + rename, mode 600). Returns false when nothing needed to change. */
export function writeUsage(rec, dir, now) {
  const file = join(dir, `${rec.accountId}.json`);
  try {
    const prev = JSON.parse(readFileSync(file, 'utf8'));
    const same =
      JSON.stringify([prev.configDir, prev.five_hour, prev.seven_day]) === JSON.stringify([rec.configDir, rec.five_hour, rec.seven_day]);
    if (same && typeof prev.fetchedAt === 'number' && now - prev.fetchedAt >= 0 && now - prev.fetchedAt < MIN_REWRITE_MS) return false;
  } catch {
    // first record (or unreadable): writes
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return true;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Shell of the original command: the same one in which Claude Code runs the statusline. Outside Windows, /bin/sh. On
 * Windows, Git Bash (CLAUDE_CODE_GIT_BASH_PATH or the bin\bash.exe of the installation of the PATH's git.exe; never
 * the PATH's `bash`, which may be WSL's); without it, Node's default (cmd.exe).
 */
export function originalShell(env = process.env) {
  if (process.platform !== 'win32') return true;
  const explicit = (env.CLAUDE_CODE_GIT_BASH_PATH ?? '').trim();
  if (explicit && isFile(explicit)) return explicit;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir) || !isFile(join(dir, 'git.exe'))) continue;
    // git.exe in <Git>\cmd (the one in the Windows PATH) or in <Git>\mingw64\bin (the one in the Git Bash PATH).
    const bash = [resolve(dir, '..', 'bin', 'bash.exe'), resolve(dir, '..', '..', 'bin', 'bash.exe')].find(isFile);
    if (bash) return bash;
  }
  return true;
}

/** The capture: never throws. */
export function tap(stdinText, env = process.env, now = Date.now()) {
  try {
    if (!stdinText || !stdinText.includes('rate_limits')) return false;
    const rec = usageRecord(JSON.parse(stdinText), now, env);
    return rec ? writeUsage(rec, usageDirOf(env), now) : false;
  } catch {
    return false;
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return Buffer.alloc(0);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

async function main() {
  let input = Buffer.alloc(0);
  try {
    input = await readStdin();
  } catch {
    // no readable stdin: goes on with only the original command
  }
  const command = originalCommand(process.argv.slice(2));
  if (!command) {
    tap(input.toString('utf8'));
    return;
  }
  // The original command starts before the capture (which runs while it works): zero extra delay.
  let child;
  try {
    child = spawn(command, { shell: originalShell(), stdio: ['pipe', 'inherit', 'inherit'] });
  } catch {
    tap(input.toString('utf8'));
    process.exitCode = 127;
    return;
  }
  const done = new Promise((ok) => {
    child.on('error', () => ok(127));
    child.on('close', (code, signal) => ok(code ?? (signal ? 1 : 0)));
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.stdin.on('error', () => {}); // the command may exit without reading stdin (EPIPE)
  child.stdin.end(input);
  tap(input.toString('utf8'));
  process.exitCode = await done;
}

/** Called directly (and not imported by the tests)? Compares real paths (the repo may be a symlink). */
function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch(() => {
    process.exitCode = process.exitCode || 1;
  });
}
