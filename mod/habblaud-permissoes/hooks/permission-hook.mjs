#!/usr/bin/env node
// Habblaud PermissionRequest hook: lets you approve or deny from the office the permission requests
// of Claude Code ("Do you want to…") and answer the AskUserQuestion questions. It reaches the session in one
// of these ways (this file is the single source for both):
//
// - the `habblaud-permissoes` plugin from the repository's marketplace (Claude Code 2.1.287+): the hooks.json
//   next to it runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs"`, with the port coming from
//   HABBLAUD_PORT. Claude Code copies ONLY the plugin's folder to the plugin cache: that is why there are no
//   imports outside `node:*` here;
// - `npm run hooks:install` (earlier versions), which writes in each <account>/settings.json:
//
//   node /path/to/habblaud/mod/habblaud-permissoes/hooks/permission-hook.mjs [--port 4747] [--timeout 300]
//
// Claude Code shows the dialog in the terminal and runs this hook AT THE SAME TIME (whichever answer comes
// first wins); in background subagents the dialog only appears after the hook ends. The hook:
// 1. reads the request's JSON from stdin (session_id, tool_name, tool_input, permission_suggestions...);
// 2. sends it to POST http://127.0.0.1:<port>/api/permissions. If Habblaud doesn't answer, refuses
//    (feature turned off) or says there is no page open or that it doesn't know the session, it exits right
//    away, without deciding: the terminal goes on as normal;
// 3. otherwise, waits for the decision in GET /api/permissions/:id/wait (responses of up to 25 s, in a loop)
//    until the timeout (default 5 min: --timeout <s> or HABBLAUD_PERMISSION_TIMEOUT);
// 4. approved/denied: prints the decision (hookSpecificOutput.decision). Question answered: approves
//    the call with the ORIGINAL input plus `answers` ({question text: chosen labels}, as the
//    hooks documentation says to answer AskUserQuestion); the page chooses by position and the texts
//    come from stdin. "Answer in terminal", timed out or any error: exits without printing anything, and
//    what you answer in the terminal is what counts.
//
// Rules: plain Node (22+), no dependencies; never hangs or breaks the session (every error = exit without
// deciding). Only talks to 127.0.0.1. HABBLAUD_HOOK_DEBUG=1 writes what happens to stderr.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const DEFAULT_TIMEOUT_S = 300;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 86_400;
/** Maximum wait of each long-poll (the server answers "pending" and the hook asks again). */
const WAIT_S = 25;
/** Registering the request: if Habblaud doesn't answer within this, it is down (or hung). */
const REGISTER_TIMEOUT_MS = 2_000;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
/** Texts of the arguments sent to Habblaud (the server only shows a preview). */
const MAX_STRING = 8_000;
/** Request body (the server refuses above 256 KB). */
const MAX_BODY = 200_000;
/** Tool for the questions to the user: the answer is a choice (`answer` decision), not approve/deny. */
const ASK_TOOL = 'AskUserQuestion';

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-hook] ${msg}\n`) : () => {};

/** Port and timeout: arguments (--port, --timeout) or environment (HABBLAUD_PORT, HABBLAUD_PERMISSION_TIMEOUT). */
export function parseOptions(argv, env = process.env) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number.parseInt(arg('port') ?? env.HABBLAUD_PORT ?? '', 10);
  const timeout = Number(arg('timeout') ?? env.HABBLAUD_PERMISSION_TIMEOUT ?? '');
  return {
    port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT,
    timeoutMs: (Number.isFinite(timeout) && timeout > 0 ? Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, timeout)) : DEFAULT_TIMEOUT_S) * 1_000,
  };
}

/** Cuts long texts in the arguments (the content of a huge Write, for example). */
export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

/**
 * Body sent to Habblaud: only what it uses (no transcript_path or the rest of stdin). If it is still
 * big (many edits at once), the texts are cut shorter.
 */
export function requestBody(input, timeoutMs) {
  const body = { session_id: input.session_id, tool_name: input.tool_name, tool_input: {}, timeout_ms: timeoutMs };
  for (const k of ['agent_id', 'agent_type', 'cwd']) if (typeof input[k] === 'string') body[k] = input[k];
  if (Array.isArray(input.permission_suggestions)) body.permission_suggestions = input.permission_suggestions;
  for (const max of [MAX_STRING, 1_000, 200]) {
    body.tool_input = trimInput(input.tool_input ?? {}, max);
    if (JSON.stringify(body).length <= MAX_BODY) break;
  }
  return body;
}

/** Non-empty text (the answers use the texts from stdin as they came, without trimming). */
const text = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * `answers` of AskUserQuestion ({ORIGINAL question text: ORIGINAL labels of the chosen options, in their
 * order, and the free text at the end, joined with ", "}) from the answers by position coming from Habblaud.
 * undefined = it can't be answered (exits without deciding and the terminal counts): input without `questions`,
 * question with no answer or answered twice, invalid position, more than one choice without multiSelect,
 * questions with the same text.
 */
export function answersFor(answers, toolInput) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : undefined;
  if (!questions || !Array.isArray(answers) || !answers.length) return undefined;
  const out = {};
  const done = new Set();
  for (const a of answers) {
    const q = a && Number.isInteger(a.question) ? questions[a.question] : undefined;
    if (!q || typeof q !== 'object' || !text(q.question) || done.has(a.question) || Object.hasOwn(out, q.question)) return undefined;
    done.add(a.question);
    const options = Array.isArray(q.options) ? q.options : [];
    const parts = [];
    for (const i of Array.isArray(a.options) ? a.options : []) {
      const label = Number.isInteger(i) && i >= 0 ? options[i]?.label : undefined;
      if (!text(label)) return undefined;
      parts.push(label);
    }
    if (text(a.other)) parts.push(a.other.trim());
    if (!parts.length || (q.multiSelect !== true && parts.length > 1)) return undefined;
    out[q.question] = parts.join(', ');
  }
  // Every real question needs an answer (Habblaud didn't even show the invalid ones).
  if (questions.some((q, i) => q && typeof q === 'object' && text(q.question) && !done.has(i))) return undefined;
  return out;
}

/**
 * Hook output for a Habblaud decision (undefined = exit without deciding). An "always allow" rule
 * chosen on the page comes back only as the POSITION: the original suggestion that Claude Code sent is applied.
 * Question (AskUserQuestion): only `answer` approves (without `answers` the call would have no answer); deny works.
 */
export function decisionOutput(result, input) {
  if (!result || result.status !== 'decided') return undefined;
  const ask = input?.tool_name === ASK_TOOL;
  if (result.behavior === 'answer') {
    const answers = ask ? answersFor(result.answers, input.tool_input) : undefined;
    if (!answers) return undefined;
    const decision = { behavior: 'allow', updatedInput: { ...input.tool_input, answers } };
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  if (result.behavior === 'allow') {
    if (ask) return undefined;
    const decision = { behavior: 'allow' };
    const list = Array.isArray(input?.permission_suggestions) ? input.permission_suggestions : [];
    const chosen = Number.isInteger(result.suggestion) ? list[result.suggestion] : undefined;
    if (chosen && typeof chosen === 'object') decision.updatedPermissions = [chosen];
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  if (result.behavior === 'deny') {
    const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    const decision = { behavior: 'deny', message: reason ? `Denied by the user in Habblaud: ${reason}` : 'Denied by the user in Habblaud.' };
    if (result.interrupt === true) decision.interrupt = true;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
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

/** Decides the request (or not). Returns the output to print, or undefined. Never throws. */
export async function run(argv = process.argv.slice(2), env = process.env, stdinText) {
  try {
    const opts = parseOptions(argv, env);
    const raw = stdinText ?? (await readStdin());
    if (!raw) return undefined;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || typeof input.tool_name !== 'string') return undefined;
    if (input.hook_event_name !== undefined && input.hook_event_name !== 'PermissionRequest') return undefined;

    const base = `http://127.0.0.1:${opts.port}`;
    const deadline = Date.now() + opts.timeoutMs;
    const reg = await call(base, 'POST', '/api/permissions', requestBody(input, opts.timeoutMs), REGISTER_TIMEOUT_MS);
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
      const waitS = Math.max(0.05, Math.min(WAIT_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return undefined;
      const status = r.json?.status;
      if (status === 'pending') continue;
      debug(`answer: ${JSON.stringify(r.json)}`);
      return decisionOutput(r.json, input);
    }
  } catch (err) {
    debug(`error: ${err?.message ?? err}`);
    return undefined;
  }
}

/** Entry point (exported for the shortcut at the old path, scripts/permission-hook.mjs). */
export async function main() {
  const { timeoutMs } = parseOptions(process.argv.slice(2));
  // Safety net: nothing keeps the process alive beyond the timeout.
  setTimeout(() => process.exit(0), timeoutMs + 15_000).unref();
  const out = await run();
  // No process.exit() right after the fetch: on Windows (Node 23 through 24.19) it kills the process with
  // 0xC0000409 while V8 is still compiling the fetch parser in the background (libuv assert,
  // nodejs/node#56645). The process exits by itself when the loop empties, which also waits for the decision
  // to be written to the pipe (asynchronous on macOS); if something still holds the loop, the process.exit
  // comes 1 s later.
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
