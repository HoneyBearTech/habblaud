// Messages from the office (Claude Code 2.1.287+): takes to the session what you type in Habblaud (in the agent's
// panel or in the T key terminal), as if you had typed it in the terminal.
//
// What it does, and `claude plugin validate` lists exactly what the module calls (the output is in mod/README.md):
//
// 1. Every 2 s, only where the session draws (`$.session.surfaces()` empty = `claude -p`/SDK: nothing to do) or in a
//    desktop app session (CLAUDE_CODE_ENTRYPOINT=claude-desktop: SDK underneath, no surface when off screen), asks
//    the local Habblaud whether there are messages for it: POST http://127.0.0.1:<HABBLAUD_PORT or 4747>/api/mod/inbox
//    with {session, account}. The question also marks the session's presence: it is what lights up, in the office,
//    this agent's message box. When it is down, or answers anything that is not 2xx (403 = messages turned off
//    in Habblaud; 404 = a version without the route), it starts asking every 30 s until it comes back.
// 2. Each message, in order, goes to the session through `$.prompt.submit({ text, asUser: true })`: the model reads
//    it as yours, without the "The habblaud-mensagens plugin sent a message" (the session's record still names the
//    plugin). The text goes exactly as it arrived. `{drop}` (a hook refused) or an exception = failure, with the
//    reason.
//    With the session in the middle of a turn, Claude Code holds the prompt until it is free and the call can take
//    a while to return: the wait per message is at most 2 s. Past that, the message is in the session's queue and
//    counts as delivered, and the next ones of the same round go right after, in order, without waiting. This way
//    the round never takes more than a few seconds: the presence (10 s on the server) and the confirmation (30 s)
//    don't expire because of a busy session. The price: a hook that refuses the message after those 2 s doesn't
//    reach the office.
// 3. A single POST /api/mod/inbox/ack with {session, results: [{id, ok, error?}]}. No messages, no ack.
//
// Why a plugin separate from the `habblaud` mod: that one only observes (plan usage, notice below the prompt,
// /habblaud) and never changes what the session does. This one acts: it types in the session on your behalf.
// Separate, you can go without it (npm run mod:install -- --sem-mensagens) and the static analysis of each one
// stays short.
//
// Rules: no hook throws (a hook that throws is skipped, but what it left half done stays): each step has its own
// try/catch and failure = silence. One round at a time (a slow Habblaud doesn't pile up questions). No $.process,
// $.model, $.fs, reading of the conversation or tool decision; the network is only 127.0.0.1. The state lives in
// module variables: a hot reload starts over from zero (a message fetched and not confirmed fails on the server
// in 30 s).
// Claude Code may load the plugin from a copy of its own: the path helpers are copies of the ones in
// mod/habblaud/hooks/register.ts, not imports.
//
// Claude Code's static analysis: each call is written out in full ($.noun.method), the event name is
// always a string literal and `$` is only passed to functions declared at the top of this file.
import type { EngineInterface, HttpResponse, Register } from 'claude-code'

/** Habblaud's default port (the same as the server's, the mod's and docker-compose's). */
export const DEFAULT_PORT = 4747
/** Interval of the questions to Habblaud; when it is down, backs off to the second one until it comes back. */
export const POLL_MS = 2_000
export const OFFLINE_POLL_MS = 30_000
/** How long to wait for the local Habblaud to answer (`$.http.fetch` doesn't accept AbortSignal: the race is with a timer). */
export const FETCH_TIMEOUT_MS = 2_000
/** How long to wait for `$.prompt.submit` to return before treating the message as in the session's queue. */
export const SUBMIT_WAIT_MS = 2_000
/** Maximum size of a failure's reason (it comes from a hook or an exception; the message text is never cut). */
export const MAX_REASON = 500

/** Message as POST /api/mod/inbox delivers it (shared/types.ts, InboxMessage). */
export interface InboxMessage {
  id: string
  /** The text as it was typed; empty when the server sent something that is not text. */
  text: string
}

/** Result of one message, as POST /api/mod/inbox/ack receives it. */
export interface AckResult {
  id: string
  ok: boolean
  error?: string
}

/** Outcome of a `$.prompt.submit`. */
type Submitted = { ok: true } | { ok: false; error: string }

interface ModEnv {
  /** Account id (the folder name, as the server calls it); absent with neither HOME (or USERPROFILE) nor CLAUDE_CONFIG_DIR. */
  accountId?: string
  port: number
  /** Session of the Claude desktop app (CLAUDE_CODE_ENTRYPOINT=claude-desktop): runs as SDK and only has a surface
   *  while it is on the app's screen, but it is interactive and receives prompts all the same. */
  desktop: boolean
}

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in tests/habblaud-mensagens.test.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Normalizes a path (repeated slashes, `.`, `..` and the trailing slash): the mod's environment has no node:path. Copy
 * of mod/habblaud: Windows paths (with a drive or UNC) come out with `/` and the drive counts as the root; in the
 * others, `\` is part of the name.
 */
export function normalizePath(p: string): string {
  const win = /^(?:[A-Za-z]:|\\\\)/.test(p)
  const slashed = win ? p.replace(/\\/g, '/') : p
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(slashed)?.[0] ?? (win && slashed.startsWith('//') ? '/' : '')
  const rest = slashed.slice(drive.length)
  const abs = rest.startsWith('/')
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push(seg)
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return drive + (abs ? `/${joined}` : joined || (drive ? '' : '.'))
}

/** `~` at the start becomes HOME. */
function expandHome(p: string, home: string | undefined): string {
  return home && /^~(?=[\\/]|$)/.test(p) ? home + p.slice(1) : p
}

/** The account's config dir: the first item of CLAUDE_CONFIG_DIR (with `~` expanded) or ~/.claude. */
export function configDirOf(claudeConfigDir: string | undefined, home: string | undefined): string | undefined {
  const first = (claudeConfigDir ?? '').split(',')[0]?.trim() ?? ''
  if (first) return normalizePath(expandHome(first, home))
  return home ? normalizePath(`${home}/.claude`) : undefined
}

/** Account id = folder name (the server's AccountInfo.id, e.g. ".claude-conta2"). */
export function accountIdOf(configDir: string): string | undefined {
  const name = configDir.split('/').filter(Boolean).pop()
  return name && name !== '.' && name !== '..' ? name : undefined
}

export function portOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT
}

/** Body of POST /api/mod/inbox: the account only when it is known. */
export function inboxBody(session: string, account: string | undefined): string {
  return JSON.stringify(account ? { session, account } : { session })
}

/** Body of POST /api/mod/inbox/ack. */
export function ackBody(session: string, results: readonly AckResult[]): string {
  return JSON.stringify({ session, results })
}

/**
 * Reads the response of POST /api/mod/inbox; out of format = undefined (counts as "down"). An item without an id is
 * left out (there is no way to confirm it); with an id and no text, it goes in with empty text, to be confirmed as a
 * failure instead of the server waiting 30 s.
 */
export function parseInbox(text: string): InboxMessage[] | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const list = (j as Record<string, unknown>).messages
  if (!Array.isArray(list)) return undefined
  const out: InboxMessage[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (typeof m.id !== 'string' || !m.id) continue
    out.push({ id: m.id, text: typeof m.text === 'string' ? m.text : '' })
  }
  return out
}

/** The reason for a failure on a single line, with limited size: the text of a `{drop}` or the message of an exception. */
export function reasonText(raw: unknown, fallback: string): string {
  const msg = typeof raw === 'string' ? raw : raw && typeof (raw as { message?: unknown }).message === 'string' ? (raw as { message: string }).message : ''
  const line = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line
}

// ---------------------------------------------------------------------------------------------
// Module state (gone on a hot reload) and what talks to Claude Code
// ---------------------------------------------------------------------------------------------

let env: ModEnv | undefined
let timer: { cancel: () => void } | undefined
let timerMs = 0
/** One round at a time: a slow Habblaud or a busy session doesn't stack up rounds. */
let polling = false

/** The session's environment, read once per load (each name written out in full, as the analysis requires). */
async function readEnv($: EngineInterface): Promise<ModEnv> {
  if (env) return env
  // On Windows, HOME only exists if someone sets it: USERPROFILE is used (the same order as the habblaud mod).
  const home = (await $.env.get('HOME'))?.trim() || (await $.env.get('USERPROFILE'))?.trim() || undefined
  const configDir = configDirOf(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  const next: ModEnv = {
    port: portOf(await $.env.get('HABBLAUD_PORT')),
    desktop: (await $.env.get('CLAUDE_CODE_ENTRYPOINT'))?.trim() === 'claude-desktop',
  }
  const accountId = configDir ? accountIdOf(configDir) : undefined
  if (accountId) next.accountId = accountId
  env = next
  return next
}

/** What `promise` resolves to within `ms`; past that, undefined (the promise goes on by itself). */
async function waitAtMost<T>($: EngineInterface, promise: Promise<T>, ms: number): Promise<T | undefined> {
  let wait: { cancel: () => void } | undefined
  const timeout = new Promise<undefined>((resolve) => {
    wait = $.clock.after(ms, () => resolve(undefined))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    wait?.cancel()
  }
}

/** POST of a JSON to the local Habblaud with a 2 s deadline: the response, or undefined (down, hung). Never throws. */
async function postJson($: EngineInterface, port: number, path: string, body: string): Promise<HttpResponse | undefined> {
  try {
    const request = $.http.fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      // Without the Content-Type, the server's guard refuses the POST (415).
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    })
    return await waitAtMost($, request, FETCH_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

/** One message for the session, as if you had typed it. Never throws. */
async function submitOne($: EngineInterface, text: string): Promise<Submitted> {
  try {
    const r = await $.prompt.submit({ text, asUser: true })
    if (typeof r?.drop === 'string') return { ok: false, error: reasonText(r.drop, 'a session hook refused the message') }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: reasonText(err, "the session didn't accept the message") }
  }
}

/** Sends the messages to the session, in order, and returns the result of each one. Never throws. */
async function deliver($: EngineInterface, messages: readonly InboxMessage[]): Promise<AckResult[]> {
  const results: AckResult[] = []
  /** A call went past the deadline: the session is busy and the next ones enter the queue behind it, without waiting. */
  let queued = false
  for (const m of messages) {
    if (!m.text.trim()) {
      results.push({ id: m.id, ok: false, error: 'empty message' })
      continue
    }
    const submitted = submitOne($, m.text)
    if (queued) {
      void submitted
      results.push({ id: m.id, ok: true })
      continue
    }
    const out = await waitAtMost($, submitted, SUBMIT_WAIT_MS)
    if (!out) {
      queued = true
      results.push({ id: m.id, ok: true })
    } else results.push(out.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: out.error })
  }
  return results
}

/** (Re)schedules the rounds: 2 s with Habblaud up, 30 s when it is down. */
function schedule($: EngineInterface, ms: number): void {
  if (timer && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => {
    void round($)
  })
}

/** One round: fetches this session's messages, sends each one and confirms. Never throws. */
async function round($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const e = await readEnv($)
    const surfaces = await $.session.surfaces()
    if (!surfaces.length && !e.desktop) return
    const session = await $.session.id()
    const res = await postJson($, e.port, '/api/mod/inbox', inboxBody(session, e.accountId))
    const messages = res?.ok ? parseInbox(res.text) : undefined
    if (!messages) {
      schedule($, OFFLINE_POLL_MS)
      return
    }
    schedule($, POLL_MS)
    if (!messages.length) return
    const results = await deliver($, messages)
    // The confirmation failed: the server treats the messages as failed in 30 s ("the session didn't confirm delivery").
    await postJson($, e.port, '/api/mod/inbox/ack', ackBody(session, results))
  } catch {
    // silence: the next round tries again
  } finally {
    polling = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      schedule($, POLL_MS)
    } catch {
      // without the rounds, the session goes on as always
    }
    return next(e)
  })
}
