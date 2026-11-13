// Habblaud mod (Claude Code 2.1.287+): connects each session to the office without reading the conversation.
//
// It does three small things, and `claude plugin validate` lists exactly what the module calls (the output
// is in mod/README.md):
//
// 1. Plan usage (replaces the statusline tap): on `session.start` and on each `session.measure`
//    (after each turn and when a limit moves a whole point) it writes
//    <HABBLAUD_USAGE_DIR or ~/.habblaud/usage>/<account>.json in the SAME format as scripts/statusline-tap.mjs
//    ({accountId, configDir, fetchedAt, five_hour, seven_day}, `resets_at` in seconds) plus
//    `source: "mod"`. The server reads these files in server/accounts/statusline.ts.
// 2. A line below the prompt when ANOTHER session needs you: every 5 s it asks the local Habblaud
//    (GET /api/mod/summary, which already takes this session and its subagents off the list). When it is down,
//    the line goes away and the questions become every 30 s until it comes back. Only where the session draws
//    (`$.session.surfaces()` empty = `claude -p`/SDK: nothing to show, nothing to ask).
// 3. /habblaud: summary of the office, answered by the mod itself (doesn't call the model, doesn't spend usage).
//
// Rules: no hook throws (a hook that throws is skipped, but what it left half done stays): each
// step has its own try/catch and failure = silence. No $.process, $.model, $.prompt, tool
// decision or reading of the conversation; the network is only 127.0.0.1. The state lives in module variables: a
// hot reload starts over from zero, which here costs at most one extra rewrite of the usage file.
//
// Claude Code's static analysis: each call is written out in full ($.noun.method), the event name is
// always a string literal and `$` is only passed to functions declared at the top of this file.
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

/** Habblaud's default port (the same as the server's, the permission hook's and docker-compose's). */
export const DEFAULT_PORT = 4747
/** Interval of the questions to Habblaud; when it is down, backs off to the second one until it comes back. */
export const POLL_MS = 5_000
export const OFFLINE_POLL_MS = 30_000
/** How long to wait for the local Habblaud to answer (`$.http.fetch` doesn't accept AbortSignal: the race is with a timer). */
export const FETCH_TIMEOUT_MS = 2_000
/** Identical values written less than this long ago are not rewritten (the same rule as the tap). */
export const MIN_REWRITE_MS = 10_000
/** Names in the line below the prompt before the "and N more". */
const MAX_NAMES = 3

/** A window in the tap's format: percentage 0–100 and reset in SECONDS since the epoch. */
export interface UsageWindow {
  utilization: number
  resets_at?: number
}

/** The usage file: the tap's format plus `source`, to know who wrote it. */
export interface UsageRecord {
  accountId: string
  configDir: string
  fetchedAt: number
  five_hour?: UsageWindow
  seven_day?: UsageWindow
  source: 'mod'
}

/** Who needs you, as GET /api/mod/summary returns it (without demo and without this session). */
export interface WaitingAgent {
  id: string
  name: string
  room: string
  account: string
  waitingFor: string
  since?: number
  /** There is a permission request to answer from the office. */
  answerable: boolean
}

export interface Summary {
  version: string
  agents: number
  working: number
  waiting: WaitingAgent[]
}

/** Result of a question to Habblaud: response, down or an old version, without the mod's route. */
type Asked = { kind: 'ok'; summary: Summary } | { kind: 'offline' } | { kind: 'outdated' }

interface ModEnv {
  /** The account's config dir and its id (basename), as the tap computes them; with neither HOME (or USERPROFILE) nor CLAUDE_CONFIG_DIR, absent. */
  configDir?: string
  accountId?: string
  /** Usage folder; absent with neither HOME (or USERPROFILE) nor HABBLAUD_USAGE_DIR. */
  usageDir?: string
  port: number
}

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in tests/habblaud.test.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Normalizes a path (repeated slashes, `.`, `..` and the trailing slash): the mod's environment has no node:path.
 * Windows paths (with a drive or UNC) come out with `/`, which Windows also accepts, and the drive letter (`C:`) counts
 * as the root: this way the server in Docker, which is Linux, still finds the account's folder name in the written
 * configDir. In the others, `\` is part of the name (Linux and macOS) and stays as it is.
 */
export function normalizePath(p: string): string {
  const win = /^(?:[A-Za-z]:|\\\\)/.test(p)
  const slashed = win ? p.replace(/\\/g, '/') : p
  // Root: the drive, or one of the two UNC slashes (`\\nas\share` becomes `//nas/share`, which needs both).
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

/** `~` at the start becomes HOME (as the tap does with CLAUDE_CONFIG_DIR and HABBLAUD_USAGE_DIR). */
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

export function usageDirOf(habblaudUsageDir: string | undefined, home: string | undefined): string | undefined {
  const d = (habblaudUsageDir ?? '').trim()
  if (d) return normalizePath(expandHome(d, home))
  return home ? normalizePath(`${home}/.habblaud/usage`) : undefined
}

export function portOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT
}

/**
 * A window of `$.session.usage().rateLimits` in the tap's format. `percentUsed` comes from 0 to 100 (it goes over
 * 100 only on a blown spend limit, which we don't write); `resetsAt` comes in ISO 8601 and the tap writes SECONDS.
 */
export function windowOf(rl: SessionRateLimit | undefined): UsageWindow | undefined {
  if (!rl || typeof rl.percentUsed !== 'number' || !Number.isFinite(rl.percentUsed)) return undefined
  const w: UsageWindow = { utilization: Math.min(100, Math.max(0, rl.percentUsed)) }
  const ms = typeof rl.resetsAt === 'string' ? Date.parse(rl.resetsAt) : Number.NaN
  if (Number.isFinite(ms)) w.resets_at = Math.round(ms / 1_000)
  return w
}

/**
 * The record written, or undefined with no usable window (outside a subscription, or before the first
 * API response, `rateLimits` comes empty). Only `five_hour` and `seven_day`: a gateway's `spend_limit`
 * is not a plan limit.
 */
export function usageRecord(rateLimits: readonly SessionRateLimit[], configDir: string, now: number): UsageRecord | undefined {
  const accountId = accountIdOf(configDir)
  if (!accountId) return undefined
  const five = windowOf(rateLimits.find((r) => r.kind === 'five_hour'))
  const week = windowOf(rateLimits.find((r) => r.kind === 'seven_day'))
  if (!five && !week) return undefined
  const rec: UsageRecord = { accountId, configDir, fetchedAt: now, source: 'mod' }
  if (five) rec.five_hour = five
  if (week) rec.seven_day = week
  return rec
}

/** Text on a single line (names and rooms come from the server; a line break would ruin the status line). */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? oneLine(v) : undefined
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

/** Reads the response of GET /api/mod/summary; anything out of format = undefined (counts as "down"). */
export function parseSummary(text: string): Summary | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const r = j as Record<string, unknown>
  if (!Array.isArray(r.waiting)) return undefined
  const waiting: WaitingAgent[] = []
  for (const item of r.waiting) {
    if (!item || typeof item !== 'object') continue
    const w = item as Record<string, unknown>
    const name = str(w.name)
    if (!name) continue
    const agent: WaitingAgent = {
      id: str(w.id) ?? name,
      name,
      room: str(w.room) ?? '?',
      account: str(w.account) ?? '',
      waitingFor: str(w.waitingFor) ?? 'answer in the terminal',
      answerable: w.answerable === true,
    }
    if (typeof w.since === 'number' && Number.isFinite(w.since)) agent.since = w.since
    waiting.push(agent)
  }
  return { version: str(r.version) ?? '?', agents: count(r.agents), working: count(r.working), waiting }
}

/** The line below the prompt: undefined when nobody (besides this session) needs you. */
export function statusText(waiting: readonly WaitingAgent[]): string | undefined {
  const first = waiting[0]
  if (!first) return undefined
  if (waiting.length === 1) return `🏢 ${first.name} needs you in ${first.room}`
  const shown = waiting.slice(0, MAX_NAMES).map((w) => `${w.name} (${w.room})`)
  const rest = waiting.length - shown.length
  return `🏢 ${waiting.length} need you: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`
}

/** The /habblaud answer with Habblaud up. */
export function summaryText(s: Summary, url: string): string {
  const agents = s.agents === 1 ? '1 agent' : `${s.agents} agents`
  const waiting = s.waiting.length === 0 ? 'nobody needs you' : s.waiting.length === 1 ? '1 needs you' : `${s.waiting.length} need you`
  const lines = [`Habblaud ${s.version} at ${url}`, `${agents} · ${s.working} working · ${waiting}`]
  for (const w of s.waiting) lines.push(`✋ ${w.name} (${w.room}): ${w.waitingFor}${w.answerable ? ' · you can reply from the office' : ''}`)
  return lines.join('\n')
}

export function offlineText(url: string): string {
  return `Habblaud did not answer at ${url}. To start it: npm run docker:up in the Habblaud folder.`
}

export function outdatedText(url: string): string {
  return `Habblaud at ${url} is on a version without the mod's route. To update: git pull and npm run docker:up in the Habblaud folder.`
}

// ---------------------------------------------------------------------------------------------
// Module state (gone on a hot reload) and what talks to Claude Code
// ---------------------------------------------------------------------------------------------

let env: ModEnv | undefined
/** Last write of the usage file (key = file + values), so as not to rewrite the same thing in less than 10 s. */
let lastWrite: { key: string; at: number } | undefined
/** Text of the status line; null = we haven't touched it yet in this load (the first call always goes through). */
let lastStatus: string | undefined | null = null
let timer: { cancel: () => void } | undefined
let timerMs = 0
/** One question at a time: a slow Habblaud doesn't pile up questions. */
let polling = false

/** The session's environment, read once per load (each name written out in full, as the analysis requires). */
async function readEnv($: EngineInterface): Promise<ModEnv> {
  if (env) return env
  // On Windows, HOME only exists if someone sets it: USERPROFILE is used (the same order as the server, HOME and then homedir()).
  const home = (await $.env.get('HOME'))?.trim() || (await $.env.get('USERPROFILE'))?.trim() || undefined
  const configDir = configDirOf(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  const next: ModEnv = {
    port: portOf(await $.env.get('HABBLAUD_PORT')),
    usageDir: usageDirOf(await $.env.get('HABBLAUD_USAGE_DIR'), home),
  }
  if (configDir) {
    next.configDir = configDir
    const accountId = accountIdOf(configDir)
    if (accountId) next.accountId = accountId
  }
  env = next
  return next
}

/** Writes this account's usage (if there are windows and something changed or the interval has passed). May throw: the caller swallows it. */
async function writeUsage($: EngineInterface, rateLimits: readonly SessionRateLimit[]): Promise<void> {
  if (!rateLimits.length) return
  const e = await readEnv($)
  if (!e.configDir || !e.usageDir) return
  const now = await $.clock.now()
  const rec = usageRecord(rateLimits, e.configDir, now)
  if (!rec) return
  const file = `${e.usageDir}/${rec.accountId}.json`
  const key = JSON.stringify([file, rec.configDir, rec.five_hour, rec.seven_day])
  if (lastWrite && lastWrite.key === key && now - lastWrite.at >= 0 && now - lastWrite.at < MIN_REWRITE_MS) return
  // $.fs.write creates the folder if it is missing and is NOT atomic: the server's reader ignores a half
  // read and keeps the last good record (server/accounts/statusline.ts).
  await $.fs.write(file, `${JSON.stringify(rec)}\n`)
  lastWrite = { key, at: now }
}

/** GET /api/mod/summary with a 2 s deadline; never throws. */
async function askHabblaud($: EngineInterface, port: number, query: string): Promise<Asked> {
  let wait: { cancel: () => void } | undefined
  const timeout = new Promise<undefined>((resolve) => {
    wait = $.clock.after(FETCH_TIMEOUT_MS, () => resolve(undefined))
  })
  try {
    const res = await Promise.race([$.http.fetch(`http://127.0.0.1:${port}/api/mod/summary${query}`, { headers: { accept: 'application/json' } }), timeout])
    if (!res) return { kind: 'offline' }
    // JSON 404 = a Habblaud from before the mod (unknown route); any other 404 = it is not Habblaud.
    if (res.status === 404 && (res.text.includes('unknown route') || res.text.includes('rota desconhecida'))) return { kind: 'outdated' }
    const summary = res.ok ? parseSummary(res.text) : undefined
    return summary ? { kind: 'ok', summary } : { kind: 'offline' }
  } catch {
    return { kind: 'offline' }
  } finally {
    wait?.cancel()
  }
}

/** Changes the status line only when the text changes. */
function setStatus($: EngineInterface, text: string | undefined): void {
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

/** (Re)schedules the questions: 5 s with Habblaud up, 30 s when it is down. */
function schedule($: EngineInterface, ms: number): void {
  if (timer && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => {
    void poll($)
  })
}

/** One round of the notice below the prompt. Never throws. */
async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const surfaces = await $.session.surfaces()
    if (!surfaces.length) {
      setStatus($, undefined)
      return
    }
    const e = await readEnv($)
    const params = new URLSearchParams()
    if (e.accountId) params.set('account', e.accountId)
    params.set('session', await $.session.id())
    const asked = await askHabblaud($, e.port, `?${params.toString()}`)
    if (asked.kind !== 'ok') {
      setStatus($, undefined)
      schedule($, OFFLINE_POLL_MS)
      return
    }
    schedule($, POLL_MS)
    setStatus($, statusText(asked.summary.waiting))
  } catch {
    // silence: the next round tries again
  } finally {
    polling = false
  }
}

/** The /habblaud text: the whole office (without filtering out this session, so the numbers match the screen). */
async function habblaudText($: EngineInterface): Promise<string> {
  const e = await readEnv($)
  const url = `http://localhost:${e.port}`
  const asked = await askHabblaud($, e.port, '')
  if (asked.kind === 'outdated') return outdatedText(url)
  if (asked.kind === 'offline') return offlineText(url)
  return summaryText(asked.summary, url)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'habblaud', description: 'Habblaud summary: how many agents, who is working and who needs you' })
    } catch {
      // without the command, the rest goes on
    }
    try {
      const usage = await $.session.usage()
      await writeUsage($, usage.rateLimits)
    } catch {
      // failure to write = silence (Habblaud keeps the last number it had)
    }
    try {
      schedule($, POLL_MS)
    } catch {
      // without the notice below the prompt, the rest goes on
    }
    return next(e)
  })

  // After each turn and when a limit moves one point. `e` brings the same numbers as
  // `$.session.usage()` at that instant, so there is no reason to ask again.
  on('session.measure', async ($, e, next) => {
    try {
      await writeUsage($, e.rateLimits)
    } catch {
      // failure to write = silence
    }
    return next(e)
  })

  on('command.run', { command: 'habblaud' }, async ($) => {
    try {
      return { text: await habblaudText($) }
    } catch {
      return { text: offlineText(`http://localhost:${env?.port ?? DEFAULT_PORT}`) }
    }
  })
}
