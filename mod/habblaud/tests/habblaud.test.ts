// Tests of the Habblaud mod, run by Claude Code itself: `claude plugin test` inside mod/habblaud
// (no session, no login, no network). The stubs answer in place of Claude Code: env, clock
// (mock.clock), $.session.usage, $.session.id, $.session.surfaces, $.fs.write, $.http.fetch and $.ui.status.
import type { CommandRunInput, HttpResponse, On, SessionRateLimit } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { accountIdOf, configDirOf, normalizePath, parseSummary, statusText, usageDirOf, windowOf, type Summary, type WaitingAgent } from '../hooks/register'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const SEC = (iso: string) => Date.parse(iso) / 1_000
const PORT = '4850'
const SUMMARY_URL = `http://127.0.0.1:${PORT}/api/mod/summary`

const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-06T14:00:00Z' },
  { kind: 'seven_day', percentUsed: 15.5, resetsAt: '2026-10-09T23:00:00.000Z' },
  // a gateway's spend limit: it is not a plan limit, it is left out
  { kind: 'spend_limit', percentUsed: 120 },
]
const CONTEXT = { window: 200_000, tokens: 1_000, percent: 0.5 }

function waiting(name: string, room: string, over: Partial<WaitingAgent> = {}): WaitingAgent {
  return { id: `.claude:${name}`, name, room, account: '.claude', waitingFor: 'approve a permission', answerable: false, ...over }
}

function summary(list: WaitingAgent[], over: Partial<Summary> = {}): Summary {
  return { version: '0.3.0', agents: 7, working: 3, waiting: list, ...over }
}

interface World {
  env?: Record<string, string>
  limits?: SessionRateLimit[]
  surfaces?: ReadonlyArray<'terminal' | 'desktop'>
  /** Habblaud's response: a summary, 'offline' (connection refused), 'hang' (doesn't answer) or a raw HTTP. */
  answer?: () => Summary | 'offline' | 'hang' | { status: number; text: string }
  /** $.fs.write fails (folder without permission, disk full...). */
  writeFails?: boolean
}

/** Registers all the stubs (before the first call on $, as the kit requires) and returns what was captured. */
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, w.env ?? { HOME: '/home/someone', CLAUDE_CONFIG_DIR: '~/.claude-conta2,/other/folder', HABBLAUD_PORT: PORT })
  const writes: Array<{ path: string; text: string }> = []
  const fetches: string[] = []
  const statuses: Array<string | undefined> = []
  const commands: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.usage', () => ({ value: { startedAt: NOW, context: CONTEXT, rateLimits: w.limits ?? LIMITS } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: w.surfaces ?? ['terminal'] }))
  on('fs.write', ($, e) => {
    if (w.writeFails) return { deny: 'EACCES: permission denied' }
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', async ($, e) => {
    fetches.push(e.url)
    const a = w.answer ? w.answer() : summary([])
    if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
    if (a === 'hang') {
      await clock.sleep(60_000)
      return { deny: 'too late' }
    }
    return { value: 'status' in a ? response(a.status, a.text) : response(200, JSON.stringify(a)) }
  })
  return { clock, writes, fetches, statuses, commands }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
/** /habblaud typed in the terminal (the kit asks for the origin and where the answer appears). */
const RUN: CommandRunInput = { command: 'habblaud', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }

function response(status: number, text: string): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text }
}

describe('plan usage', () => {
  test('session.start writes the file in the format of the tap, with source "mod"', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect(w.commands).toEqual(['habblaud'])
    expect(w.writes.length).toBe(1)
    // The kit passes the written path through the path of the machine that runs the test (on Windows, C:\home\...): without the drive.
    expect(w.writes[0]?.path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')).toBe('/home/someone/.habblaud/usage/.claude-conta2.json')
    expect(w.writes[0]?.text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(w.writes[0]?.text ?? '')).toEqual({
      accountId: '.claude-conta2',
      configDir: '/home/someone/.claude-conta2',
      fetchedAt: NOW,
      five_hour: { utilization: 42, resets_at: SEC('2026-10-06T14:00:00Z') },
      seven_day: { utilization: 15.5, resets_at: SEC('2026-10-09T23:00:00Z') },
      source: 'mod',
    })
  })

  test('HABBLAUD_USAGE_DIR with ~ and, with no CLAUDE_CONFIG_DIR, the account ~/.claude', async ($, on) => {
    const w = world(on, { env: { HOME: '/home/someone', HABBLAUD_USAGE_DIR: '~/usage/' } })
    await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['rateLimits'] })
    expect(w.writes.map((x) => x.path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''))).toEqual(['/home/someone/usage/.claude.json'])
    expect(JSON.parse(w.writes[0]?.text ?? '')).toMatchObject({ accountId: '.claude', configDir: '/home/someone/.claude' })
  })

  test('Windows: with no HOME the USERPROFILE is used, and CLAUDE_CONFIG_DIR with \\ gives the same account', async ($, on) => {
    const w = world(on, { env: { USERPROFILE: 'C:\\Users\\someone', CLAUDE_CONFIG_DIR: 'C:\\Users\\someone\\.claude-conta2\\', HABBLAUD_PORT: PORT } })
    await $.session.start(START)
    expect(w.writes.length).toBe(1)
    // The kit passes the written path through the path of the machine that runs the test: checks only the end.
    expect(w.writes[0]?.path).toMatch(/someone[\\/]\.habblaud[\\/]usage[\\/]\.claude-conta2\.json$/)
    expect(JSON.parse(w.writes[0]?.text ?? '')).toMatchObject({ accountId: '.claude-conta2', configDir: 'C:/Users/someone/.claude-conta2' })
  })

  test('session.measure: does not rewrite equal values in less than 10 s; rewrites if it changed or after that', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.start(START)
    expect(w.writes.length).toBe(1)
    await w.clock.advance(5_000)
    await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['context'] })
    expect(w.writes.length).toBe(1)
    const moved: SessionRateLimit[] = [{ ...LIMITS[0]!, percentUsed: 43 }, LIMITS[1]!]
    await $.session.measure({ context: CONTEXT, rateLimits: moved, changed: ['rateLimits'] })
    expect(w.writes.length).toBe(2)
    expect(JSON.parse(w.writes[1]?.text ?? '')).toMatchObject({ fetchedAt: NOW + 5_000, five_hour: { utilization: 43 } })
    await w.clock.advance(10_000)
    await $.session.measure({ context: CONTEXT, rateLimits: moved, changed: ['cost'] })
    expect(w.writes.length).toBe(3)
    expect(JSON.parse(w.writes[2]?.text ?? '')).toMatchObject({ fetchedAt: NOW + 15_000 })
  })

  test('with no plan window (outside a subscription, only spend_limit) it writes nothing', async ($, on) => {
    const w = world(on, { limits: [] })
    await $.session.start(START)
    await $.session.measure({ context: CONTEXT, rateLimits: [{ kind: 'spend_limit', percentUsed: 80 }], changed: ['rateLimits'] })
    expect(w.writes).toEqual([])
  })

  test('failure to write = silence: the session starts and the command is registered', async ($, on) => {
    const w = world(on, { writeFails: true })
    expect(await $.session.start(START)).toEqual({ cwd: '/work' })
    expect(await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['rateLimits'] })).toEqual({ changed: ['rateLimits'] })
    expect(w.commands).toEqual(['habblaud'])
    expect(w.writes).toEqual([])
  })
})

describe('line below the prompt', () => {
  test('nobody, one, several people (cuts at 3 names); only calls $.ui.status when the text changes', async ($, on) => {
    let list: WaitingAgent[] = []
    const w = world(on, { answer: () => summary(list) })
    await $.session.start(START)
    expect(w.fetches).toEqual([])
    await w.clock.advance(5_000)
    expect(w.fetches).toEqual([`${SUMMARY_URL}?account=.claude-conta2&session=sess-1`])
    expect(w.statuses).toEqual([undefined])
    list = [waiting('Valentina', 'online-store')]
    await w.clock.advance(5_000)
    expect(w.statuses.at(-1)).toBe('🏢 Valentina needs you in online-store')
    await w.clock.advance(5_000)
    expect(w.statuses.length).toBe(2)
    list = [waiting('Valentina', 'online-store'), waiting('Elias', 'app-mobile')]
    await w.clock.advance(5_000)
    expect(w.statuses.at(-1)).toBe('🏢 2 need you: Valentina (online-store), Elias (app-mobile)')
    list = [...list, waiting('Bia', 'site'), waiting('Caio', 'api'), waiting('Dora', 'docs')]
    await w.clock.advance(5_000)
    expect(w.statuses.at(-1)).toBe('🏢 5 need you: Valentina (online-store), Elias (app-mobile), Bia (site) and 2 more')
    list = []
    await w.clock.advance(5_000)
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.statuses.length).toBe(5)
  })

  test('Habblaud down: clears the line and backs off to 30 s until it is back', async ($, on) => {
    let up = false
    const w = world(on, { answer: () => (up ? summary([waiting('Valentina', 'online-store')]) : 'offline') })
    await $.session.start(START)
    await w.clock.advance(5_000)
    expect(w.fetches.length).toBe(1)
    expect(w.statuses).toEqual([undefined])
    await w.clock.advance(25_000)
    expect(w.fetches.length).toBe(1)
    up = true
    await w.clock.advance(5_000)
    expect(w.fetches.length).toBe(2)
    expect(w.statuses.at(-1)).toBe('🏢 Valentina needs you in online-store')
    await w.clock.advance(5_000)
    expect(w.fetches.length).toBe(3)
  })

  test('Habblaud stuck: gives up after 2 s and clears the line', async ($, on) => {
    let hang = false
    const w = world(on, { answer: () => (hang ? 'hang' : summary([waiting('Valentina', 'online-store')])) })
    await $.session.start(START)
    await w.clock.advance(5_000)
    expect(w.statuses).toEqual(['🏢 Valentina needs you in online-store'])
    hang = true
    await w.clock.advance(5_000)
    expect(w.statuses.length).toBe(1)
    await w.clock.advance(2_000)
    expect(w.statuses).toEqual(['🏢 Valentina needs you in online-store', undefined])
  })

  test('session with no surface (claude -p, SDK): does not even ask Habblaud', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(15_000)
    expect(w.fetches).toEqual([])
    expect(w.statuses).toEqual([undefined])
  })
})

describe('/habblaud', () => {
  test('up: version, address, count and one line per person waiting (the whole office)', async ($, on) => {
    const w = world(on, {
      answer: () => summary([waiting('Valentina', 'online-store', { answerable: true }), waiting('Elias', 'app-mobile', { waitingFor: 'answer in the terminal' })]),
    })
    const out = await $.command.run(RUN)
    expect(w.fetches).toEqual([SUMMARY_URL])
    expect(out.text).toBe(
      [
        'Habblaud 0.3.0 at http://localhost:4850',
        '7 agents · 3 working · 2 need you',
        '✋ Valentina (online-store): approve a permission · you can reply from the office',
        '✋ Elias (app-mobile): answer in the terminal',
      ].join('\n'),
    )
  })

  test('up and nobody waiting', async ($, on) => {
    world(on, { answer: () => summary([], { agents: 1, working: 0 }) })
    const out = await $.command.run(RUN)
    expect(out.text).toBe('Habblaud 0.3.0 at http://localhost:4850\n1 agent · 0 working · nobody needs you')
  })

  test('down: says how to start it', async ($, on) => {
    world(on, { answer: () => 'offline' })
    const out = await $.command.run(RUN)
    expect(out.text).toBe('Habblaud did not answer at http://localhost:4850. To start it: npm run docker:up in the Habblaud folder.')
  })

  test('Habblaud from before the mod (404 "unknown route"): asks to update', async ($, on) => {
    let text = '{"error":"rota desconhecida"}'
    world(on, { env: { HOME: '/home/someone' }, answer: () => ({ status: 404, text }) })
    const out = await $.command.run(RUN)
    expect(out.text).toMatch(/^Habblaud at http:\/\/localhost:4747 is on a version without the mod's route/)
    // The same answer from a server whose texts are in English ("unknown route").
    text = '{"error":"unknown route"}'
    expect((await $.command.run(RUN)).text).toBe(out.text)
    // Any other 404 is not Habblaud.
    text = '{"error":"not found"}'
    expect((await $.command.run(RUN)).text).not.toBe(out.text)
  })
})

describe('pure functions', () => {
  test('paths, account and usage folder as the tap computes them', () => {
    expect(normalizePath('/a//b/./c/../d/')).toBe('/a/b/d')
    expect(configDirOf(' ~/.claude-conta2 , /x', '/home/f')).toBe('/home/f/.claude-conta2')
    expect(configDirOf(undefined, '/home/f/')).toBe('/home/f/.claude')
    expect(configDirOf('', undefined)).toBeUndefined()
    expect(usageDirOf(undefined, '/home/f')).toBe('/home/f/.habblaud/usage')
    expect(usageDirOf(undefined, undefined)).toBeUndefined()
  })

  test('Windows paths: \\ becomes /, the drive counts as root and ~\\ is also the HOME', () => {
    expect(normalizePath('C:\\Users\\f\\.claude-conta2\\')).toBe('C:/Users/f/.claude-conta2')
    expect(normalizePath('C:\\Users\\..\\..\\x')).toBe('C:/x')
    expect(configDirOf('C:\\Users\\f\\.claude-conta2', undefined)).toBe('C:/Users/f/.claude-conta2')
    expect(configDirOf('~\\.claude-conta2', 'C:\\Users\\f')).toBe('C:/Users/f/.claude-conta2')
    expect(configDirOf(undefined, 'C:\\Users\\f')).toBe('C:/Users/f/.claude')
    expect(accountIdOf('C:/Users/f/.claude-conta2')).toBe('.claude-conta2')
    expect(usageDirOf(undefined, 'C:\\Users\\f')).toBe('C:/Users/f/.habblaud/usage')
  })

  test('UNC stays UNC, and outside Windows the \\ is part of the name', () => {
    expect(normalizePath('\\\\nas\\share\\usage\\')).toBe('//nas/share/usage')
    expect(usageDirOf('\\\\nas\\share\\usage', undefined)).toBe('//nas/share/usage')
    expect(normalizePath('/home/u/proj\\x')).toBe('/home/u/proj\\x')
    expect(accountIdOf(normalizePath('/home/u/account\\2'))).toBe('account\\2')
  })

  test('window: percentage limited to 0–100, reset in seconds; an invalid date is left out', () => {
    expect(windowOf({ kind: 'five_hour', percentUsed: 101.5, resetsAt: '2026-10-06T14:00:00.400Z' })).toEqual({ utilization: 100, resets_at: SEC('2026-10-06T14:00:00Z') })
    expect(windowOf({ kind: 'five_hour', percentUsed: 7, resetsAt: 'tomorrow' })).toEqual({ utilization: 7 })
    expect(windowOf({ kind: 'five_hour', percentUsed: Number.NaN })).toBeUndefined()
  })

  test('summary: odd format = down; texts become a single line', () => {
    expect(parseSummary('<html>')).toBeUndefined()
    expect(parseSummary('{"version":"1"}')).toBeUndefined()
    const s = parseSummary(JSON.stringify({ version: '0.3.0', agents: 2, working: 1, waiting: [{ name: 'Ana\nB', room: 'r', answerable: 'yes' }, { room: 'no name' }] }))
    expect(s?.waiting).toEqual([{ id: 'Ana B', name: 'Ana B', room: 'r', account: '', waitingFor: 'answer in the terminal', answerable: false }])
    expect(statusText([])).toBeUndefined()
  })
})
