// Tests of the messages plugin, run by Claude Code itself: `claude plugin test` inside
// mod/habblaud-mensagens (no session, no login, no network). The stubs answer in place of Claude Code and
// Habblaud: env, clock (mock.clock), $.session.id, $.session.surfaces, $.http.fetch (the server's two
// routes) and the lower prompt.submit (the session: accepts, a hook refuses, the call throws or gets stuck).
import type { HttpResponse, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { accountIdOf, ackBody, configDirOf, inboxBody, MAX_REASON, normalizePath, parseInbox, portOf, reasonText, type InboxMessage } from '../hooks/register'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const PORT = '4850'
const INBOX_URL = `http://127.0.0.1:${PORT}/api/mod/inbox`
const ACK_URL = `${INBOX_URL}/ack`
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' }

/** Habblaud's response to the inbox: messages, 'offline' (connection refused), 'hang' (doesn't answer) or a raw HTTP. */
type Answer = InboxMessage[] | 'offline' | 'hang' | { status: number; text: string }
/** What the session does with a prompt: it goes in, a hook refuses, the call throws, or gets stuck (busy session). */
type Fate = 'ok' | 'drop' | 'throw' | 'hang'

interface World {
  env?: Record<string, string>
  surfaces?: ReadonlyArray<'terminal' | 'desktop'>
  /** Default: no messages. */
  inbox?: () => Answer
  /** Default: the ack answers 200. */
  ack?: () => 'ok' | 'offline' | 'hang'
  /** Default: 'ok'. */
  fate?: (text: string) => Fate
}

interface Sent {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

function response(status: number, text: string): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text }
}

/** A queue of responses: each question takes the next one; when it runs out, no messages. */
function batches(...list: Answer[]): () => Answer {
  return () => list.shift() ?? []
}

/** Registers all the stubs (before the first call on $, as the kit requires) and returns what was captured. */
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, w.env ?? { HOME: '/home/someone', CLAUDE_CONFIG_DIR: '~/.claude-conta2', HABBLAUD_PORT: PORT })
  const sent: Sent[] = []
  const submits: Array<{ text: string; origin: unknown }> = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: w.surfaces ?? ['terminal'] }))
  on('http.fetch', async ($, e) => {
    const body = e.init?.body
    sent.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body: body === undefined ? undefined : JSON.parse(body) })
    if (e.url.endsWith('/ack')) {
      const a = w.ack ? w.ack() : 'ok'
      if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
      if (a === 'hang') {
        await clock.sleep(60_000)
        return { deny: 'too late' }
      }
      return { value: response(200, '{"ok":true}') }
    }
    const a = w.inbox ? w.inbox() : []
    if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
    if (a === 'hang') {
      await clock.sleep(60_000)
      return { deny: 'too late' }
    }
    return { value: Array.isArray(a) ? response(200, JSON.stringify({ messages: a })) : response(a.status, a.text) }
  })
  on('prompt.submit', async ($, e) => {
    submits.push({ text: e.text, origin: e.origin })
    const fate = w.fate ? w.fate(e.text) : 'ok'
    if (fate === 'drop') return { drop: `refused by a hook: ${e.text}` }
    if (fate === 'throw') throw new Error('the session\nclosed')
    if (fate === 'hang') await clock.sleep(60_000)
    return { text: e.text }
  })
  return {
    clock,
    sent,
    submits,
    inboxes: () => sent.filter((s) => s.url === INBOX_URL),
    acks: () => sent.filter((s) => s.url === ACK_URL),
    texts: () => submits.map((s) => s.text),
  }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

describe('rounds', () => {
  test('every 2 s it asks Habblaud (marks presence); with no messages, nothing goes to the session and there is no ack', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect(w.sent).toEqual([])
    await w.clock.advance(2_000)
    expect(w.sent).toEqual([{ url: INBOX_URL, method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1', account: '.claude-conta2' } }])
    await w.clock.advance(4_000)
    expect(w.inboxes().length).toBe(3)
    expect(w.acks()).toEqual([])
    expect(w.submits).toEqual([])
  })

  test('delivers in order, as if you had typed it (text intact), and confirms everything in a single POST', async ($, on) => {
    const typed = '  and then:\n- open the PR\n\n(no rush)  '
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'run the tests' }, { id: 'm2', text: typed }]) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['run the tests', typed])
    expect(w.submits[0]?.origin).toEqual({ kind: 'plugin', name: 'habblaud-mensagens', asUser: true })
    expect(w.acks()).toEqual([{ url: ACK_URL, method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1', results: [{ id: 'm1', ok: true }, { id: 'm2', ok: true }] } }])
    await w.clock.advance(2_000)
    expect(w.sent.map((s) => s.url)).toEqual([INBOX_URL, ACK_URL, INBOX_URL])
    expect(w.submits.length).toBe(2)
  })

  test('a refusal from a hook and an exception become a failure with the reason; with no text, fails without going to the session', async ($, on) => {
    const raw = JSON.stringify({
      messages: [
        { id: 'a', text: 'go ahead' },
        { id: 'b', text: 'forbidden' },
        { id: 'c', text: 'breaks' },
        { id: 'd', text: '  \n ' },
        { id: 'e', text: 42 },
        // no id: there is no way to confirm it, it is left out
        { text: 'orphan' },
      ],
    })
    const w = world(on, {
      inbox: batches({ status: 200, text: raw }),
      fate: (t) => (t === 'forbidden' ? 'drop' : t === 'breaks' ? 'throw' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['go ahead', 'forbidden', 'breaks'])
    expect(w.acks()[0]?.body).toEqual({
      session: 'sess-1',
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'refused by a hook: forbidden' },
        // The lower hook that throws is skipped and, with nothing below it, the call rejects: the reason is the kit's.
        { id: 'c', ok: false, error: expect.stringMatching(/\S/) },
        { id: 'd', ok: false, error: 'empty message' },
        { id: 'e', ok: false, error: 'empty message' },
      ],
    })
  })

  test('busy session: past 2 s, it counts as delivered and the next ones go right after, in order; the rounds go on', async ($, on) => {
    const w = world(on, {
      inbox: batches([
        { id: 'm1', text: 'first' },
        { id: 'm2', text: 'second' },
        { id: 'm3', text: 'third' },
      ]),
      fate: (t) => (t === 'first' ? 'hang' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['first'])
    expect(w.acks()).toEqual([])
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['first', 'second', 'third'])
    expect(w.acks().map((a) => a.body)).toEqual([
      {
        session: 'sess-1',
        results: [
          { id: 'm1', ok: true },
          { id: 'm2', ok: true },
          { id: 'm3', ok: true },
        ],
      },
    ])
    const asked = w.inboxes().length
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBeGreaterThan(asked)
  })

  test('one round at a time: with the session busy and the ack stuck, the question in the middle is skipped', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'first' }]), fate: () => 'hang', ack: () => 'hang' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    // The round goes from 2 s (question) to 4 s (submit deadline) and from there to 6 s (ack deadline): the 4 s one doesn't start.
    await w.clock.advance(3_000)
    expect(w.inboxes().length).toBe(1)
    expect(w.acks().length).toBe(1)
    await w.clock.advance(3_000)
    expect(w.inboxes().length).toBeGreaterThan(1)
    expect(w.texts()).toEqual(['first'])
  })

  test('ack that fails = silence: the rounds go on', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'hi' }]), ack: () => 'offline' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.acks().length).toBe(1)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(2)
    expect(w.texts()).toEqual(['hi'])
  })

  test('Habblaud down, 403 (messages turned off) or 404 (version without the route): backs off to 30 s until it is back', async ($, on) => {
    let answer: Answer = 'offline'
    const w = world(on, { inbox: () => answer })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    await w.clock.advance(28_000)
    expect(w.inboxes().length).toBe(1)
    answer = { status: 403, text: '{"error":"messages from the office disabled"}' }
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(2)
    answer = { status: 404, text: '{"error":"unknown route"}' }
    await w.clock.advance(30_000)
    expect(w.inboxes().length).toBe(3)
    answer = []
    await w.clock.advance(30_000)
    expect(w.inboxes().length).toBe(4)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(5)
    expect(w.acks()).toEqual([])
  })

  test('Habblaud stuck: gives up in 2 s and backs off to 30 s', async ($, on) => {
    let hang = true
    const w = world(on, { inbox: () => (hang ? 'hang' : []) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    await w.clock.advance(31_000)
    expect(w.inboxes().length).toBe(1)
    hang = false
    await w.clock.advance(1_000)
    expect(w.inboxes().length).toBe(2)
  })

  test('session with no surface (claude -p, SDK): does not even ask Habblaud', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(10_000)
    expect(w.sent).toEqual([])
  })

  test('desktop app session off screen (SDK with no surface): asks anyway', async ($, on) => {
    const w = world(on, { surfaces: [], env: { HOME: '/home/someone', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', HABBLAUD_PORT: PORT } })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
  })

  test('with no HOME or CLAUDE_CONFIG_DIR: asks without the account, on the default port', async ($, on) => {
    const w = world(on, { env: {} })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.sent).toEqual([{ url: 'http://127.0.0.1:4747/api/mod/inbox', method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1' } }])
  })
})

describe('pure functions', () => {
  test('inbox: odd format = down; item with no id is left out; no text becomes empty text', () => {
    expect(parseInbox('<html>')).toBeUndefined()
    expect(parseInbox('[]')).toBeUndefined()
    expect(parseInbox('{"messages":{}}')).toBeUndefined()
    expect(parseInbox('{"messages":[]}')).toEqual([])
    expect(parseInbox(JSON.stringify({ messages: [{ id: 'a', text: ' x\n' }, { id: '', text: 'y' }, { text: 'z' }, null, { id: 'b' }] }))).toEqual([
      { id: 'a', text: ' x\n' },
      { id: 'b', text: '' },
    ])
  })

  test('bodies of the two routes', () => {
    expect(JSON.parse(inboxBody('s', '.claude'))).toEqual({ session: 's', account: '.claude' })
    expect(JSON.parse(inboxBody('s', undefined))).toEqual({ session: 's' })
    expect(JSON.parse(ackBody('s', [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'no' }]))).toEqual({
      session: 's',
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'no' },
      ],
    })
  })

  test('failure reason: one line, limited size, and the default when there is no text', () => {
    expect(reasonText('a\nhook\t refused ', 'default')).toBe('a hook refused')
    expect(reasonText(new Error('boom'), 'default')).toBe('boom')
    expect(reasonText({ message: 'from another world' }, 'default')).toBe('from another world')
    expect(reasonText('   ', 'default')).toBe('default')
    expect(reasonText(undefined, 'default')).toBe('default')
    const long = reasonText('x'.repeat(2_000), 'default')
    expect(long.length).toBe(MAX_REASON)
    expect(long.endsWith('…')).toBe(true)
  })

  test('account and port as the habblaud mod computes them (on Windows too)', () => {
    expect(normalizePath('/a//b/./c/../d/')).toBe('/a/b/d')
    expect(configDirOf(' ~/.claude-conta2 , /x', '/home/f')).toBe('/home/f/.claude-conta2')
    expect(configDirOf(undefined, '/home/f/')).toBe('/home/f/.claude')
    expect(configDirOf('', undefined)).toBeUndefined()
    expect(configDirOf('C:\\Users\\f\\.claude-conta2\\', undefined)).toBe('C:/Users/f/.claude-conta2')
    expect(accountIdOf('C:/Users/f/.claude-conta2')).toBe('.claude-conta2')
    expect(accountIdOf('/')).toBeUndefined()
    expect(portOf('4850')).toBe(4850)
    expect(portOf('0')).toBe(4747)
    expect(portOf('abc')).toBe(4747)
    expect(portOf(undefined)).toBe(4747)
  })
})
