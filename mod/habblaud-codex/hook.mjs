#!/usr/bin/env node
// Habblaud hook for OpenAI Codex (the `codex` CLI and the desktop app, which write to the same CODEX_HOME): shows in
// the office what the Codex sessions do and lets you approve or deny the approval requests from the office
// (PermissionRequest). `npm run codex:install` adds to <CODEX_HOME>/hooks.json, at the END of each event's list,
// a group that runs:
//
//   node "/path/to/habblaud/mod/habblaud-codex/hook.mjs"
//
// The command never takes options: Codex keeps each hook's trust (approved by you in /hooks) in a hash that
// includes the command. Port and wait are in ~/.habblaud/codex-hook.json ({port, permissionTimeoutS}, written by the
// installer); HABBLAUD_PORT works as a fallback (the hook's environment is that of the process that started the Codex
// daemon, so variables exported in your shell don't always get here).
//
// The hook:
// 1. reads the event's JSON from stdin (session_id, hook_event_name, cwd, transcript_path...);
// 2. sends the event, with the texts cut, to POST http://127.0.0.1:<port>/api/codex/events (short deadline), with
//    the account (basename of CODEX_HOME, as the server computes it) and the CODEX_HOME path;
// 3. only on PermissionRequest: registers the request in POST /api/permissions (provider "codex") and waits for the
//    decision in GET /api/permissions/:id/wait up to the wait in the file (default 25 s, between 5 and 120). Approved:
//    prints the allow decision; denied: deny with the reason. Anything else ("answer in the terminal", timed out,
//    Habblaud down or with no page open): exits without printing anything and Codex follows the normal approval.
//    Note: Codex only shows the approval in the terminal AFTER the hook ends (meanwhile, the terminal shows the
//    hook's statusMessage).
//
// Rules: plain Node (22+), only `node:*`, no dependencies; never hangs or breaks the session: every error = exit
// with 0 and no output (never with 2, which in Codex denies the request). Never prints updatedInput,
// updatedPermissions or interrupt (Codex doesn't accept them: the hook "fails" without deciding). On observation
// events, nothing goes to stdout (on UserPromptSubmit and SessionStart it would become model context). Only talks
// to 127.0.0.1.
// HABBLAUD_HOOK_DEBUG=1 writes what happens to stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
/** Default wait for a decision in the office (seconds). */
export const DEFAULT_WAIT_S = 25;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 120;
/** Configuration file, in ~/.habblaud (the installer writes it). */
export const CONFIG_FILE = 'codex-hook.json';
/** Events sent to Habblaud (PermissionRequest too, before registering the request). */
export const OBSERVED = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PermissionRequest']);
/** Deadline for sending an event: Habblaud answers right away (and the hook can't delay Codex). */
const EVENT_TIMEOUT_MS = 1_500;
/** SessionEnd has only 1 s in Codex (and always runs in the foreground). */
const SESSION_END_TIMEOUT_MS = 600;
/** Registering the request: if Habblaud doesn't answer within this, it is down (or hung). */
const REGISTER_TIMEOUT_MS = 2_000;
/** Maximum wait of each long-poll (the server answers "pending" and the hook asks again). */
const POLL_S = 25;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
/** Texts of the event and of the arguments sent to Habblaud (the server only shows previews). */
const MAX_STRING = 8_000;
/** Request body (the server refuses above 256 KB). */
const MAX_BODY = 200_000;

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-codex] ${msg}\n`) : () => {};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

/** Absolute path, with `~`/`$HOME` expanded and no trailing slash (as the server normalizes the account folders). */
function expandHome(p, home) {
  const abs = resolve(p.trim().replace(/^~(?=[\\/]|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home));
  return abs.length > 1 ? abs.replace(/[\\/]+$/, '') : abs;
}

/**
 * Port and wait: ~/.habblaud/codex-hook.json ({port, permissionTimeoutS}); with no port in the file, HABBLAUD_PORT;
 * otherwise the defaults. Missing or unreadable file = defaults.
 */
export function readConfig(env = process.env) {
  const home = env.HOME || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const f = isObject(file) ? file : {};
  const filePort = Number(f.port);
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  const wait = Number(f.permissionTimeoutS);
  return {
    port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT,
    waitMs: (Number.isFinite(wait) && wait > 0 ? Math.min(MAX_WAIT_S, Math.max(MIN_WAIT_S, wait)) : DEFAULT_WAIT_S) * 1_000,
  };
}

/**
 * The session's CODEX_HOME: the variable, if it came; otherwise the folder above sessions/YYYY/MM/DD/ (or above
 * archived_sessions/) in the transcript_path; otherwise ~/.codex.
 */
export function codexHomeOf(env, input) {
  const home = env.HOME || homedir();
  const fromEnv = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  if (fromEnv) return expandHome(fromEnv, home);
  const t = typeof input?.transcript_path === 'string' ? input.transcript_path : '';
  const m = /^(.+)[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/][^\\/]+$/.exec(t) ?? /^(.+)[\\/]archived_sessions[\\/][^\\/]+$/.exec(t);
  if (m && isAbsolute(m[1])) return expandHome(m[1], home);
  return join(home, '.codex');
}

/** Account id = basename of CODEX_HOME (as the server gives ids to the accounts; it resolves collisions by the path). */
export function accountOf(codexHome) {
  return basename(codexHome) || codexHome;
}

/** Cuts long texts (command output, huge patch...). */
export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

/** The value with the texts cut; if it is still too big in the body, cuts shorter. */
function fitted(v, size) {
  let out = v;
  for (const max of [MAX_STRING, 1_000, 200]) {
    out = trimInput(v, max);
    if (size(out) <= MAX_BODY) break;
  }
  return out;
}

/** Body of POST /api/codex/events: the hook's whole stdin, with the texts cut. */
export function eventBody(input, account, codexHome) {
  const body = { account, codexHome, event: input };
  body.event = fitted(input, (event) => JSON.stringify({ ...body, event }).length);
  return body;
}

/** Body of POST /api/permissions: only what Habblaud uses (nothing from the transcript_path). */
export function permissionBody(input, account, codexHome, timeoutMs) {
  const body = { provider: 'codex', account, codexHome, session_id: input.session_id, tool_name: input.tool_name, tool_input: {}, timeout_ms: timeoutMs };
  for (const k of ['agent_id', 'agent_type', 'cwd', 'turn_id']) if (typeof input[k] === 'string') body[k] = input[k];
  body.tool_input = fitted(isObject(input.tool_input) ? input.tool_input : {}, (toolInput) => JSON.stringify({ ...body, tool_input: toolInput }).length);
  return body;
}

/** Hook output for a Habblaud decision (undefined = exit without deciding). Only allow and deny (+ message). */
export function decisionOutput(result) {
  if (!result || result.status !== 'decided') return undefined;
  if (result.behavior === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  if (result.behavior === 'deny') {
    const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    const message = reason ? `Denied by the user in Habblaud: ${reason}` : 'Denied by the user in Habblaud.';
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
  }
  return undefined;
}

function readStdin() {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    const finish = (text) => {
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(undefined));
  });
}

/** Request to the local Habblaud; null = down, timed out or unreadable response. */
async function call(base, method, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`${method} ${path}: ${err?.name ?? 'error'} ${err?.message ?? ''}`);
    return null;
  }
}

/** Sends the event and, on PermissionRequest, decides the request (or not). Returns the output to print, or undefined. Never throws. */
export async function run(env = process.env, stdinText) {
  const startedAt = Date.now();
  try {
    const raw = stdinText ?? (await readStdin());
    if (!raw) return undefined;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isObject(input) || typeof input.hook_event_name !== 'string' || typeof input.session_id !== 'string' || !input.session_id) return undefined;
    const event = input.hook_event_name;
    if (!OBSERVED.has(event)) return undefined;

    const cfg = readConfig(env);
    const codexHome = codexHomeOf(env, input);
    const account = accountOf(codexHome);
    const base = `http://127.0.0.1:${cfg.port}`;
    const sent = await call(base, 'POST', '/api/codex/events', eventBody(input, account, codexHome), event === 'SessionEnd' ? SESSION_END_TIMEOUT_MS : EVENT_TIMEOUT_MS);
    debug(`${event}: ${sent ? `${sent.status} ${JSON.stringify(sent.json ?? null)}` : 'Habblaud down'}`);
    if (event !== 'PermissionRequest' || typeof input.tool_name !== 'string' || !input.tool_name) return undefined;
    // No answer even to the event: Habblaud is down (or hung); the approval goes on in the terminal.
    if (!sent) return undefined;

    // The wait counts from the start of the hook (Codex only shows the approval in the terminal when it ends).
    const deadline = startedAt + cfg.waitMs;
    const reg = await call(base, 'POST', '/api/permissions', permissionBody(input, account, codexHome, Math.max(0, deadline - Date.now())), REGISTER_TIMEOUT_MS);
    if (!reg || reg.status !== 201 || typeof reg.json?.id !== 'string') {
      debug(`not diverted (${reg ? `${reg.status} ${JSON.stringify(reg.json ?? null)}` : 'Habblaud down'})`);
      return undefined;
    }
    const id = encodeURIComponent(reg.json.id);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        debug('timed out: the terminal counts');
        return undefined;
      }
      const waitS = Math.max(0.05, Math.min(POLL_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return undefined;
      if (r.json?.status === 'pending') continue;
      debug(`answer: ${JSON.stringify(r.json)}`);
      return decisionOutput(r.json);
    }
  } catch (err) {
    debug(`error: ${err?.message ?? err}`);
    return undefined;
  }
}

export async function main() {
  const { waitMs } = readConfig();
  // Safety net: nothing keeps the process alive beyond the wait (Codex also has the hook's timeout).
  setTimeout(() => process.exit(0), waitMs + 15_000).unref();
  const out = await run();
  // No process.exit() right after the fetch: on Windows (Node 23 through 24.19) it kills the process with 0xC0000409
  // while V8 is still compiling the fetch parser in the background (nodejs/node#56645). The process exits by itself
  // when the loop empties, which also waits for the decision to be written to the pipe; if something still holds the
  // loop, the process.exit comes 1 s later.
  const finish = () => setTimeout(() => process.exit(0), 1_000).unref();
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`, finish);
  else finish();
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
