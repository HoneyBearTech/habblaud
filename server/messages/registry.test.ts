// Registro das mensagens pelo escritório: presença das sessões (canMessage no snapshot), validação, limites, entrega
// ao plugin, confirmação, prazos, agente que sai, limpeza das resolvidas e a entrega fictícia do demo.
// Tudo com dados sintéticos e relógio injetado.
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import {
  ERR_GONE,
  ERR_NOT_CONFIRMED,
  ERR_NOT_FETCHED,
  ERR_REFUSED,
  ERR_SESSION_CHANGED,
  INBOX_BATCH,
  KEEP_MS,
  MAX_OPEN,
  MessageRegistry,
  PRESENCE_MS,
  QUEUED_TIMEOUT_MS,
  SENT_TIMEOUT_MS,
  type SendResult,
} from './registry';

setQuiet(true);

const MAIN = 'acc:1';
const SESSION = 'sess-1';
const OTHER = 'acc:2';
const SUB = `${SESSION}:a1b2c3`;

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let registry: MessageRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    messages: () => registry?.reachable() ?? new Set(),
    now: clock.now,
  });
  office.addMain({ id: MAIN, account: 'acc', sessionId: SESSION, cwd: '/p/store', role: 'Main agent', startedAt: 0, status: 'idle' });
  office.addMain({ id: OTHER, account: 'acc', sessionId: 'sess-2', cwd: '/p/api', role: 'Main agent', startedAt: 0, status: 'idle' });
  registry = new MessageRegistry({
    office,
    demoAgent: (id) => office.demoAgent(id),
    demoDeliver: (id, text) => office.deliverDemoMessage(id, text),
    now: clock.now,
  });
  return { office, registry, clock };
}

const snapAgent = (office: Office, id: string): AgentInfo | undefined => office.commit().snapshot.agents.find((a) => a.id === id);

function sent(r: SendResult): string {
  if (!('message' in r)) throw new Error(`refused: ${JSON.stringify(r)}`);
  return r.message.id;
}

describe('MessageRegistry: presence', () => {
  it('the session that asks for the inbox starts receiving messages (canMessage) and the snapshot changes only on the transition', () => {
    const { office, registry, clock } = setup();
    expect(snapAgent(office, MAIN)?.canMessage).toBeUndefined();
    expect(office.commit().changed).toBe(false);

    expect(registry.inbox({ session: SESSION, account: 'acc' })).toEqual([]);
    expect(registry.canMessage(MAIN)).toBe(true);
    expect(registry.reachable()).toEqual(new Set([MAIN]));
    const c1 = office.commit();
    expect(c1.changed).toBe(true);
    expect(c1.snapshot.agents.find((a) => a.id === MAIN)?.canMessage).toBe(true);
    expect(c1.snapshot.agents.find((a) => a.id === OTHER)?.canMessage).toBeUndefined();
    expect(c1.snapshot.meta.messages).toBe(true);

    // A rodada seguinte (2 s depois) não mexe no snapshot.
    clock.advance(2_000);
    registry.inbox({ session: SESSION });
    registry.tick();
    expect(office.commit().changed).toBe(false);

    // Sem rodada por PRESENCE_MS: volta a não receber.
    clock.advance(PRESENCE_MS);
    expect(registry.canMessage(MAIN)).toBe(false);
    registry.tick();
    const c2 = office.commit();
    expect(c2.changed).toBe(true);
    expect(c2.snapshot.agents.find((a) => a.id === MAIN)?.canMessage).toBeUndefined();
  });

  it('session that is unknown, from another account, from someone who left or invalid body: no presence', () => {
    const { office, registry } = setup();
    expect(registry.inbox({ session: 'does-not-exist' })).toEqual([]);
    expect(registry.inbox({ session: SESSION, account: 'other-account' })).toEqual([]);
    expect(registry.canMessage(MAIN)).toBe(false);
    office.closeMain(OTHER);
    expect(registry.inbox({ session: 'sess-2' })).toEqual([]);
    expect(registry.canMessage(OTHER)).toBe(false);
    for (const bad of [null, {}, { session: '' }, { session: 42 }, []]) expect(() => registry.inbox(bad)).toThrow(/session/);
  });

  it('a subagent never receives (same session as the main agent: the presence goes to the main agent)', () => {
    const { office, registry } = setup();
    office.addSub({ id: SUB, parentId: MAIN, sessionId: SESSION, role: 'Explore', background: false, startedAt: 0 });
    registry.inbox({ session: SESSION });
    const snap = office.commit().snapshot;
    expect(snap.agents.find((a) => a.id === MAIN)?.canMessage).toBe(true);
    expect(snap.agents.find((a) => a.id === SUB)?.canMessage).toBeUndefined();
    expect(registry.send({ agentId: SUB, text: 'hi' })).toEqual({ error: 'unavailable', reason: expect.stringMatching(/subagents/) });
  });
});

describe('MessageRegistry: sending', () => {
  it('validates the body: agentId and text, empty and above 20,000 characters', () => {
    const { registry } = setup();
    registry.inbox({ session: SESSION });
    for (const bad of [null, {}, { agentId: MAIN }, { text: 'hi' }, { agentId: MAIN, text: 3 }]) expect(() => registry.send(bad)).toThrow(/agentId/);
    expect(() => registry.send({ agentId: MAIN, text: '  \n ' })).toThrow(/empty/);
    expect(() => registry.send({ agentId: MAIN, text: 'x'.repeat(20_001) })).toThrow(/20,000/);
    expect('message' in registry.send({ agentId: MAIN, text: 'x'.repeat(20_000) })).toBe(true);
  });

  it('agent that is unknown (not-found), without the plugin connected or that left (unavailable, with the reason)', () => {
    const { office, registry } = setup();
    expect(registry.send({ agentId: 'does-not-exist', text: 'hi' })).toEqual({ error: 'not-found' });
    expect(registry.send({ agentId: MAIN, text: 'hi' })).toEqual({ error: 'unavailable', reason: expect.stringMatching(/habblaud-mensagens/) });
    registry.inbox({ session: SESSION });
    office.closeMain(MAIN);
    expect(registry.send({ agentId: MAIN, text: 'hi' })).toEqual({ error: 'unavailable', reason: expect.stringMatching(/left/) });
  });

  it(`at most ${MAX_OPEN} unresolved messages per agent (too-many); resolved ones do not count`, () => {
    const { registry } = setup();
    registry.inbox({ session: SESSION });
    registry.inbox({ session: 'sess-2' });
    const ids = Array.from({ length: MAX_OPEN }, (_, i) => sent(registry.send({ agentId: MAIN, text: `m${i}` })));
    expect(registry.send({ agentId: MAIN, text: 'too many' })).toEqual({ error: 'too-many' });
    // Outro agente tem a própria fila.
    expect('message' in registry.send({ agentId: OTHER, text: 'hi' })).toBe(true);
    const batch = registry.inbox({ session: SESSION });
    registry.ack({ session: SESSION, results: [{ id: batch[0].id, ok: true }] });
    expect(registry.get(ids[0])?.status).toBe('delivered');
    expect('message' in registry.send({ agentId: MAIN, text: 'now it fits' })).toBe(true);
  });

  it('the response (201/GET) is only the status: the text never goes out to the page', () => {
    const { registry, clock } = setup();
    registry.inbox({ session: SESSION });
    const r = registry.send({ agentId: MAIN, text: "the user's secret" });
    expect(r).toEqual({ message: { id: expect.stringMatching(/^m-/), agentId: MAIN, status: 'queued', createdAt: clock.now(), updatedAt: clock.now() } });
    const id = sent(r);
    expect(JSON.stringify(registry.get(id))).not.toContain('secret');
  });
});

describe('MessageRegistry: delivery by the plugin', () => {
  it('the round delivers the messages of the agent itself in order (up to 5) with the text as it was typed and marks sent', () => {
    const { registry, clock } = setup();
    registry.inbox({ session: SESSION });
    registry.inbox({ session: 'sess-2' });
    const text = '  Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 in the .env\n\nand run `npm test`  ';
    const first = sent(registry.send({ agentId: MAIN, text }));
    const others = [1, 2, 3, 4].map((i) => sent(registry.send({ agentId: MAIN, text: `m${i}` })));
    sent(registry.send({ agentId: OTHER, text: 'for the other one' }));
    clock.advance(500);

    const batch = registry.inbox({ session: SESSION });
    expect(batch.length).toBe(INBOX_BATCH);
    expect(batch[0]).toEqual({ id: first, text });
    expect(batch.slice(1).map((m) => m.id)).toEqual(others);
    expect(registry.get(first)).toMatchObject({ status: 'sent', updatedAt: clock.now() });
    // Já buscadas não voltam; as do outro agente só saem para a sessão dele.
    expect(registry.inbox({ session: SESSION })).toEqual([]);
    expect(registry.inbox({ session: 'sess-2' }).map((m) => m.text)).toEqual(['for the other one']);
  });

  it('confirmation: ok → delivered with the activity (masked and cut) in the feed; failure → failed with the reason', () => {
    const { office, registry, clock } = setup();
    registry.inbox({ session: SESSION });
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const a = sent(registry.send({ agentId: MAIN, text: `Use ${secret} ${'and a bit more '.repeat(40)}` }));
    const b = sent(registry.send({ agentId: MAIN, text: 'another' }));
    const c = sent(registry.send({ agentId: MAIN, text: 'third' }));
    registry.inbox({ session: SESSION });
    office.commit();
    clock.advance(1_000);
    registry.ack({ session: SESSION, results: [{ id: a, ok: true }, { id: b, ok: false, error: 'the session refused (drop)' }, { id: c, ok: false }] });
    expect(registry.get(a)).toEqual({ id: a, agentId: MAIN, status: 'delivered', createdAt: clock.now() - 1_000, updatedAt: clock.now() });
    expect(registry.get(b)).toMatchObject({ status: 'failed', error: 'the session refused (drop)' });
    expect(registry.get(c)).toMatchObject({ status: 'failed', error: ERR_REFUSED });

    const commit = office.commit();
    const feed = commit.feed.map((f) => f.activity);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: 'communicate', icon: '✉️', text: 'Message via Habblaud', at: clock.now() });
    expect(feed[0].detail).not.toContain(secret);
    expect(feed[0].detail!.length).toBeLessThanOrEqual(300);
    expect(feed[0].detail).toMatch(/^Use /);
  });

  it('a confirmation from another session, with an unknown id or for a message not fetched is ignored; an invalid body throws', () => {
    const { registry } = setup();
    registry.inbox({ session: SESSION });
    const queued = sent(registry.send({ agentId: MAIN, text: 'in the queue' }));
    registry.ack({ session: SESSION, results: [{ id: queued, ok: true }, { id: 'does-not-exist', ok: true }, { foo: 1 }, null] });
    expect(registry.get(queued)?.status).toBe('queued');
    const [m] = registry.inbox({ session: SESSION });
    registry.ack({ session: 'sess-2', results: [{ id: m.id, ok: true }] });
    expect(registry.get(m.id)?.status).toBe('sent');
    for (const bad of [null, {}, { session: SESSION }, { session: SESSION, results: 'x' }]) expect(() => registry.ack(bad)).toThrow(/results/);
  });
});

describe('MessageRegistry: deadlines and cleanup', () => {
  it('in the queue without being fetched: fails in 60 s; fetched without confirmation: fails in 30 s', () => {
    const { registry, clock } = setup();
    registry.inbox({ session: SESSION });
    const a = sent(registry.send({ agentId: MAIN, text: 'a' }));
    clock.advance(QUEUED_TIMEOUT_MS - 1);
    // A sessão continua presente (pergunta pela caixa), mas sem buscar esta: só o prazo conta.
    registry.inbox({ session: 'sess-2' });
    registry.tick();
    expect(registry.get(a)?.status).toBe('queued');
    clock.advance(1);
    registry.tick();
    expect(registry.get(a)).toMatchObject({ status: 'failed', error: ERR_NOT_FETCHED });

    registry.inbox({ session: SESSION });
    const b = sent(registry.send({ agentId: MAIN, text: 'b' }));
    registry.inbox({ session: SESSION });
    clock.advance(SENT_TIMEOUT_MS - 1);
    registry.tick();
    expect(registry.get(b)?.status).toBe('sent');
    clock.advance(1);
    registry.tick();
    expect(registry.get(b)).toMatchObject({ status: 'failed', error: ERR_NOT_CONFIRMED });
  });

  it('a late confirmation (after the deadline) still corrects the status: the plugin is the one that knows whether it went in', () => {
    const { office, registry, clock } = setup();
    registry.inbox({ session: SESSION });
    const id = sent(registry.send({ agentId: MAIN, text: 'came in late' }));
    registry.inbox({ session: SESSION });
    clock.advance(SENT_TIMEOUT_MS);
    registry.tick();
    expect(registry.get(id)?.status).toBe('failed');
    office.commit();
    registry.ack({ session: SESSION, results: [{ id, ok: true }] });
    expect(registry.get(id)).toMatchObject({ status: 'delivered' });
    expect(registry.get(id)?.error).toBeUndefined();
    expect(office.commit().feed.map((f) => f.activity.detail)).toEqual(['came in late']);
    // Resolvida de vez: outra confirmação não muda nada.
    registry.ack({ session: SESSION, results: [{ id, ok: false, error: 'x' }] });
    expect(registry.get(id)?.status).toBe('delivered');
  });

  it('agent that leaves: the unresolved messages fail and the presence goes away', () => {
    const { office, registry } = setup();
    registry.inbox({ session: SESSION });
    const a = sent(registry.send({ agentId: MAIN, text: 'a' }));
    const b = sent(registry.send({ agentId: MAIN, text: 'b' }));
    registry.inbox({ session: SESSION });
    const c = sent(registry.send({ agentId: MAIN, text: 'c' }));
    office.closeMain(MAIN);
    registry.tick();
    for (const id of [a, b, c]) expect(registry.get(id)).toMatchObject({ status: 'failed', error: ERR_GONE });
    expect(registry.reachable().size).toBe(0);
  });

  it('/clear or /resume before the fetch: the message does not go to the new session and fails', () => {
    const { office, registry } = setup();
    registry.inbox({ session: SESSION });
    const id = sent(registry.send({ agentId: MAIN, text: 'for the old conversation' }));
    office.switchSession(MAIN, 'sess-new');
    expect(registry.inbox({ session: 'sess-new' })).toEqual([]);
    registry.tick();
    expect(registry.get(id)).toMatchObject({ status: 'failed', error: ERR_SESSION_CHANGED });
    // A mandada depois da troca vai para a sessão nova.
    const next = sent(registry.send({ agentId: MAIN, text: 'for the new one' }));
    expect(registry.inbox({ session: 'sess-new' }).map((m) => m.id)).toEqual([next]);
  });

  it('resolved ones stay 10 min for checking and then go away', () => {
    const { registry, clock } = setup();
    registry.inbox({ session: SESSION });
    const id = sent(registry.send({ agentId: MAIN, text: 'a' }));
    registry.ack({ session: SESSION, results: [{ id: registry.inbox({ session: SESSION })[0].id, ok: true }] });
    clock.advance(KEEP_MS - 1);
    registry.tick();
    expect(registry.get(id)?.status).toBe('delivered');
    clock.advance(1);
    registry.tick();
    expect(registry.get(id)).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});

describe('MessageRegistry: demo', () => {
  it('demo agent: fictional delivery in ~1 s with the activity on the agent; never goes out through the inbox', () => {
    const { office, registry, clock } = setup();
    office.setDemo(true);
    const demo = office.commit().snapshot.agents.find((a) => a.id.startsWith('demo:') && a.kind === 'main' && a.status !== 'offline')!;
    expect(demo.canMessage).toBe(true);
    const id = sent(registry.send({ agentId: demo.id, text: 'hi, demo' }));
    // Nem a sessão fictícia nem uma real recebem a mensagem do demo.
    expect(registry.inbox({ session: demo.sessionId })).toEqual([]);
    expect(registry.inbox({ session: SESSION })).toEqual([]);
    clock.advance(999);
    registry.tick();
    expect(registry.get(id)?.status).toBe('queued');
    clock.advance(1);
    registry.tick();
    expect(registry.get(id)?.status).toBe('delivered');
    const after = office.commit().snapshot.agents.find((a) => a.id === demo.id)!;
    expect(after.recent.at(-1)).toMatchObject({ kind: 'communicate', text: 'Message via Habblaud', detail: 'hi, demo' });
  });

  it('demo turned off midway: the message fails (the agent left)', () => {
    const { office, registry } = setup();
    office.setDemo(true);
    const demo = office.commit().snapshot.agents.find((a) => a.id.startsWith('demo:') && a.kind === 'main' && a.status !== 'offline')!;
    const id = sent(registry.send({ agentId: demo.id, text: 'hi' }));
    office.setDemo(false);
    registry.tick();
    expect(registry.get(id)).toMatchObject({ status: 'failed', error: ERR_GONE });
  });
});
