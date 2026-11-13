// The building uplink (server/world/uplink.ts) against the fake world server (server/test/fake-world.ts, with the
// WebSocket made by hand): when it connects, the `hello`, the whole packet on each `welcome`, the wait between
// uploads, the `ping`, the reconnection, each `goodbye`, the pause that closes before responding and the last upload
// on disk (600).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hash32 } from '../../shared/hash';
import { SPECIAL } from '../../shared/activity';
import type { Activity, AgentInfo } from '../../shared/types';
import { VISIBILITY_DEFAULTS, type GoodbyeReason, type Player, type WorldUplink } from '../../shared/world/protocol';
import schemaJson from '../../shared/world/schema.json';
import { compileValidator } from '../../shared/world/schema-validator';
import { worldSocketUrl } from '../config';
import { setQuiet } from '../log';
import { startFakeWorld, type FakeWorld } from '../test/fake-world';
import { tempDir } from '../test/fixtures';
import { WorldSettingsStore } from './settings';
import { backoffDelay, BuildingUplink, type UplinkTimers, type UplinkTiming } from './uplink';

setQuiet(true);

const validate = compileValidator(schemaJson as unknown as { [k: string]: unknown });
const EMAIL = 'ana@example.com';
const FAST: Partial<UplinkTiming> = {
  debounceMs: 40,
  minGapMs: 150,
  pingMs: 120,
  refreshMs: 60_000,
  backoffMinMs: 20,
  backoffMaxMs: 80,
  welcomeTimeoutMs: 400,
  closeWaitMs: 500,
  observeMs: 20,
};
const PLAYER: Player = {
  name: 'Ana Pixel',
  look: 'f',
  parts: {},
  traits: ['games', 'cafeina'],
  intro: 'coffee',
  visibility: { ...VISIBILITY_DEFAULTS },
  updatedAt: '2026-10-15T12:00:00Z',
};

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function agent(id: string, roomId: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id, kind: 'main', roomId, name: 'Marina', look: 'f', role: 'Main agent', sessionId: `s-${id}`, account: '.claude',
    status: 'working', recent: [], tasks: [], startedAt: 1, lastEventAt: 1, statusSince: 1,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed: hash32(id), ...extra,
  };
}

async function waitFor(cond: () => boolean, what: string, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`waiting: ${what}`);
    await new Promise((ok) => setTimeout(ok, 5));
  }
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** One turn of the event loop (what the real WebSocket has already received is processed). */
const turn = () => new Promise((ok) => setImmediate(ok));

/**
 * Manual clock for the uplink (`now` and `timers`): time only moves with `advance`, which fires each expired timer in
 * order, at its instant. The connection stays real (the WebSocket of the fake world); only the uplink waits (upload,
 * welcome, ping, reconnection, closing) run on controlled time, and the test does not depend on the machine being slow.
 */
class ManualClock {
  t = 1_000_000;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void; every?: number }>();
  readonly now = () => this.t;
  readonly timers: UplinkTimers = {
    setTimeout: (fn, ms) => this.add(fn, ms),
    clearTimeout: (h) => void this.pending.delete(h as number),
    setInterval: (fn, ms) => this.add(fn, ms, Math.max(1, ms)),
    clearInterval: (h) => void this.pending.delete(h as number),
  };

  private add(fn: () => void, ms: number, every?: number): number {
    const id = ++this.seq;
    this.pending.set(id, { at: this.t + Math.max(0, ms), fn, every });
    return id;
  }

  /** Advances `ms`: each expired timer fires at its instant (`now()` is its instant), in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every?: number }] | undefined;
      for (const e of this.pending) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, timer] = next;
      this.t = Math.max(this.t, timer.at);
      if (timer.every) timer.at += timer.every;
      else this.pending.delete(id);
      timer.fn();
    }
    this.t = end;
  }
}

interface Harness {
  world: FakeWorld;
  store: WorldSettingsStore;
  uplink: BuildingUplink;
  token: string;
  file: string;
  lastFile: string;
  agents: AgentInfo[];
  change(): void;
  goodbyes: GoodbyeReason[];
  changes: { n: number };
  /** meta() on each change notice. */
  metas: unknown[];
  canAct: { v: boolean };
  make(): BuildingUplink;
}

async function start(
  opts: {
    session?: 'approved' | 'waiting' | 'no-player' | 'none';
    start?: boolean;
    tokensVisible?: boolean;
    compactions?: boolean;
    booting?: { v: boolean };
    /** The uplink time on a manual clock (with `timing` on top of FAST). */
    clock?: ManualClock;
    timing?: Partial<UplinkTiming>;
  } = {},
): Promise<Harness> {
  const world = await startFakeWorld();
  closers.push(world.close);
  const tmp = tempDir();
  closers.push(tmp.cleanup);
  const token = randomBytes(32).toString('base64url');
  world.accounts.set(EMAIL, { email: EMAIL, password: 'x', verified: true, access: 'approved', code: '123456', player: PLAYER, locale: 'pt-BR' });
  world.devices.set(token, { email: EMAIL, deviceId: 'dev_1' });
  const file = join(tmp.dir, 'world.json');
  const lastFile = join(tmp.dir, 'world-last-uplink.json');
  const store = new WorldSettingsStore(file);
  const mode = opts.session ?? 'approved';
  const player = { ...PLAYER, visibility: { ...PLAYER.visibility, tokensVisible: opts.tokensVisible ?? true, compactions: opts.compactions ?? false } };
  if (mode !== 'none') {
    store.save({ deviceId: 'dev_1', token, email: EMAIL, access: mode === 'waiting' ? 'waiting' : 'approved', ...(mode === 'no-player' ? {} : { player }) });
  }
  const listeners = new Set<() => void>();
  const h = {
    world,
    store,
    token,
    file,
    lastFile,
    agents: [
      agent('.claude:101', '/Users/ana/secret-project'),
      agent('s-101:agent-1', '/Users/ana/secret-project', { kind: 'sub', parentId: '.claude:101', look: 'm' }),
      agent('.codex:thr-9', '/Users/ana/other', { provider: 'codex', status: 'idle' }),
      agent('demo:agent-1', 'demo:/room', { status: 'working' }),
    ],
    goodbyes: [] as GoodbyeReason[],
    changes: { n: 0 },
    metas: [] as unknown[],
    canAct: { v: true },
    change: () => listeners.forEach((cb) => cb()),
  } as Omit<Harness, 'uplink' | 'make'> as Harness;
  h.make = () => {
    const u = new BuildingUplink({
      url: worldSocketUrl(world.base),
      version: '0.11.0',
      build: () => ({ commit: 'a'.repeat(40), dirty: true, builtAt: '2026-10-15T00:00:00Z' }) as never,
      locale: () => 'es',
      store,
      canAct: () => h.canAct.v,
      agents: () => h.agents,
      subscribe: (cb) => {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
      tokens: () => ({ day: 12_345, week: 678_901 }),
      ...(opts.booting ? { booting: () => opts.booting!.v } : {}),
      lastFile,
      onGoodbye: (r) => h.goodbyes.push(r),
      onChange: () => {
        h.changes.n++;
        h.metas.push(h.uplink?.meta());
      },
      timing: { ...FAST, ...opts.timing },
      ...(opts.clock ? { now: opts.clock.now, timers: opts.clock.timers } : {}),
      random: () => 0.5,
    });
    closers.push(() => u.stop());
    return u;
  };
  h.uplink = h.make();
  if (opts.start !== false) h.uplink.start();
  return h;
}

const agentsOf = (u: WorldUplink) => u.floors.flatMap((f) => f.agents);

describe('BuildingUplink: connection and uploads', () => {
  it('hello only with token, version, build and language; with the welcome, the whole packet (valid, without demo)', async () => {
    const h = await start();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first upload');
    const conn = h.world.ws.connections[0];
    expect(conn.url).toBe('/v1/socket');
    expect(JSON.stringify(conn.headers)).not.toContain(h.token);
    expect(h.world.ws.hellos[0]).toEqual({ t: 'hello', v: 1, version: '0.11.0', build: { commit: 'a'.repeat(40), dirty: true }, locale: 'es', token: h.token });
    expect(conn.messages[0].t).toBe('hello');
    const { uplink, bytes } = h.world.ws.uplinks[0];
    expect(validate(uplink)).toEqual([]);
    expect(uplink.floors).toHaveLength(2);
    expect(agentsOf(uplink)).toHaveLength(3);
    expect(uplink.tokens).toEqual({ day: 12_000, week: 680_000 });
    for (const leak of ['demo', '/Users', 'secret-project', 'other', '.claude', '.codex', 'thr-9', 's-101']) {
      expect(JSON.stringify(uplink), leak).not.toContain(leak);
    }
    const sub = agentsOf(uplink).find((a) => a.kind === 'sub')!;
    expect(agentsOf(uplink).map((a) => a.id)).toContain(sub.parentId);
    // Status and last upload: the same object that went on the wire.
    await waitFor(() => !!h.uplink.status().lastAck, 'ack');
    expect(h.uplink.status()).toMatchObject({ connected: true, paused: false, floors: 2, agents: 3, lastAck: { ok: true } });
    const last = h.uplink.lastUplink()!;
    expect(last.uplink).toEqual(uplink);
    expect(last.bytes).toBe(bytes);
    expect(last.ack).toMatchObject({ ok: true, bytes });
    expect(last.ack!.at).toEqual(expect.any(Number));
    expect(h.uplink.meta()).toEqual({ connected: true, paused: false, floors: 2, agents: 3, lastUplinkAt: last.at });
    expect(h.changes.n).toBeGreaterThan(0);
  });

  it('last upload on disk: mode 600, without token, reread only in the same session', async () => {
    const h = await start();
    await waitFor(() => !!h.uplink.lastUplink()?.ack, 'ack');
    expect(statSync(h.lastFile).mode & 0o777).toBe(0o600);
    const text = readFileSync(h.lastFile, 'utf8');
    expect(text).not.toContain(h.token);
    expect(JSON.parse(text).uplink).toEqual(h.uplink.lastUplink()!.uplink);
    h.uplink.stop();
    // Another process, same session: shows the last upload before connecting.
    h.canAct.v = false;
    const again = h.make();
    again.start();
    expect(again.lastUplink()).toEqual(h.uplink.lastUplink());
    // Signed out of the account: it goes away from memory and from disk.
    h.store.clear();
    again.sync();
    expect(again.lastUplink()).toBeUndefined();
    expect(existsSync(h.lastFile)).toBe(false);
  });

  it('only connects with the approved account, the character, the terminal lock and without pause', async () => {
    const h = await start({ session: 'waiting' });
    await sleep(80);
    expect(h.world.ws.connections).toHaveLength(0);
    h.store.update({ access: 'approved', player: undefined });
    h.uplink.sync();
    await sleep(80);
    expect(h.world.ws.connections).toHaveLength(0); // no character
    h.store.update({ player: PLAYER });
    h.canAct.v = false;
    h.uplink.sync();
    h.store.update({ paused: true });
    h.canAct.v = true;
    h.uplink.sync();
    await sleep(80);
    expect(h.world.ws.connections).toHaveLength(0);
    h.store.update({ paused: undefined });
    h.uplink.sync();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'upload');
    // Without the terminal lock, disconnects.
    h.canAct.v = false;
    h.uplink.sync();
    await waitFor(() => h.world.ws.open.length === 0, 'closed');
  });

  it('sends on change: waits from the first change, one upload every minGap and nothing if the packet did not change', async () => {
    // Controlled uplink time (without the ping, which has its own case): each upload is noted at the instant it went out.
    const clock = new ManualClock();
    const h = await start({ clock, timing: { pingMs: 3_600_000 } });
    const sent: number[] = [];
    let lastAt = -1;
    const run = async (ms: number) => {
      for (let left = ms; left > 0; left -= 5) {
        clock.advance(Math.min(5, left));
        const at = h.uplink.lastUplink()?.at;
        if (at !== undefined && at !== lastAt) {
          sent.push(at);
          lastAt = at;
        }
        await turn();
      }
    };
    await waitFor(() => h.uplink.status().connected, 'welcome');
    await run(5);
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
    expect(sent).toEqual([clock.t - 5]);
    sent.length = 0;
    // Changes with no effect on the packet (the office changes all the time: activity, speech bubbles...).
    for (let i = 0; i < 10; i++) {
      h.change();
      await run(15);
    }
    await run(250);
    expect(sent).toEqual([]);
    // Now it really changes, without stopping, for 600 ms.
    const t0 = clock.t;
    for (let i = 0; i < 40; i++) {
      h.agents = [...h.agents, agent(`.claude:${200 + i}`, '/Users/ana/secret-project')];
      h.change();
      await run(15);
    }
    await run(300);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.length).toBeLessThanOrEqual(Math.ceil((clock.t - t0) / FAST.minGapMs!) + 1);
    // the first goes out `debounceMs` after the first change (without restarting the wait on each change)
    expect(sent[0] - t0).toBe(FAST.debounceMs);
    for (let i = 1; i < sent.length; i++) expect(sent[i] - sent[i - 1]).toBeGreaterThanOrEqual(FAST.minGapMs!);
    // what went out reached the world, in order, and the last upload has all the agents
    await waitFor(() => h.world.ws.uplinks.length === 1 + sent.length, 'all the uploads in the world');
    expect(agentsOf(h.world.ws.uplinks[sent.length].uplink)).toHaveLength(43);
  });

  it('ping every pingMs', async () => {
    const clock = new ManualClock();
    const h = await start({ clock });
    await waitFor(() => h.uplink.status().connected, 'welcome');
    clock.advance(0);
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
    clock.advance(FAST.pingMs! - 1);
    await sleep(30);
    expect(h.world.ws.pings).toBe(0);
    clock.advance(1);
    await waitFor(() => h.world.ws.pings === 1, 'first ping');
    clock.advance(FAST.pingMs!);
    await waitFor(() => h.world.ws.pings === 2, 'second ping');
  });

  it('no response to the ping, closes and reconnects', async () => {
    const clock = new ManualClock();
    const h = await start({ clock });
    h.world.ws.options.pong = false;
    await waitFor(() => h.uplink.status().connected, 'welcome');
    clock.advance(0);
    await waitFor(() => h.world.ws.uplinks.length === 1 && !!h.uplink.status().lastAck, 'first and the ack');
    // Silence: the pings of 1 and 2 × pingMs go out; the one of 3 × pingMs (more than 2.5 pings with nothing) closes the connection.
    clock.advance(2 * FAST.pingMs!);
    await waitFor(() => h.world.ws.pings === 2, 'two pings without an answer');
    expect(h.world.ws.open).toHaveLength(1);
    clock.advance(FAST.pingMs!);
    await waitFor(() => h.world.ws.open.length === 0, 'closed because of the silence');
    expect(h.world.ws.pings).toBe(2);
    clock.advance(FAST.backoffMaxMs!);
    await waitFor(() => h.world.ws.connections.length === 2, 'reconnected');
  });

  it('dropped: reconnects with a wait and sends the whole packet again, even if the same', async () => {
    const h = await start();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
    h.world.ws.connections[0].drop();
    await waitFor(() => h.world.ws.uplinks.length === 2, 'resend');
    expect(h.world.ws.connections).toHaveLength(2);
    expect(h.world.ws.uplinks[1].uplink).toEqual(h.world.ws.uplinks[0].uplink);
    expect(h.world.ws.uplinks[1].conn).toBe(2);
  });

  it('no welcome in time: closes and tries again', async () => {
    const clock = new ManualClock();
    const h = await start({ start: false, clock });
    h.world.ws.options.hello = 'silent';
    h.uplink.start();
    await waitFor(() => h.world.ws.open.length === 1, 'connected');
    clock.advance(FAST.welcomeTimeoutMs! - 1);
    await sleep(30);
    expect(h.world.ws.open).toHaveLength(1);
    clock.advance(1);
    await waitFor(() => h.world.ws.open.length === 0, 'closed at the welcome deadline');
    expect(h.world.ws.connections).toHaveLength(1);
    clock.advance(FAST.backoffMaxMs!);
    await waitFor(() => h.world.ws.connections.length === 2, 'second attempt');
    expect(h.world.ws.uplinks).toHaveLength(0);
  });

  it('ack with error: lastAck with the code; unknown code becomes internal', async () => {
    const h = await start({ start: false });
    h.world.ws.options.ack = 'name_pool';
    h.uplink.start();
    await waitFor(() => !!h.uplink.status().lastAck, 'ack');
    expect(h.uplink.status().lastAck).toEqual({ ok: false, error: 'name_pool' });
    expect(h.uplink.lastUplink()!.ack).toEqual({ ok: false, error: 'name_pool', at: expect.any(Number) });
    h.world.ws.options.ack = 'something_new';
    h.agents = h.agents.slice(1);
    h.change();
    await waitFor(() => h.world.ws.uplinks.length === 2 && h.uplink.status().lastAck?.error === 'internal', 'new ack');
  });

  it('the theme and the player options: changed theme sends again; tokens only with tokensVisible', async () => {
    const h = await start({ tokensVisible: false });
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
    expect(h.world.ws.uplinks[0].uplink.tokens).toBeUndefined();
    h.store.setTheme('christmas');
    h.uplink.themeChanged();
    await waitFor(() => h.world.ws.uplinks.length === 2, 'theme');
    expect(h.world.ws.uplinks[1].uplink.theme).toBe('christmas');
  });

  it('welcome.building: floors and agents of the world until the first upload from here', async () => {
    const h = await start({ start: false });
    h.world.ws.options.building = { id: 'acc_1', floors: 7, agents: { total: 12, working: 5, waiting: 1, idle: 6 }, state: 'away' };
    h.uplink.start();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
    // In the welcome notice (before the upload goes out), the summary is the world's; afterward, the one from here.
    expect(h.metas).toContainEqual({ connected: true, paused: false, floors: 7, agents: 12 });
    await waitFor(() => h.uplink.meta().floors === 2, 'upload');
    expect(h.uplink.meta()).toMatchObject({ floors: 2, agents: 3 });
  });
});

describe('BuildingUplink: visitors (Phase 4)', () => {
  it('visitors {count} on the building connection becomes meta.visitors (with a change notice); disappears when the connection drops', async () => {
    const h = await start();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first upload');
    expect(h.uplink.meta()).not.toHaveProperty('visitors');
    const city: unknown[] = [];
    h.uplink.attachCity({ opened() {}, closed() {}, message: (m) => city.push(m), wantsCity: false });
    const conn = h.world.ws.connections[0]!;
    const before = h.changes.n;
    conn.send({ t: 'visitors', count: 3 });
    await waitFor(() => h.uplink.meta().visitors === 3, 'count');
    expect(h.changes.n).toBeGreaterThan(before);
    expect(h.uplink.status().visitors).toBe(3);
    expect(city).toEqual([{ t: 'visitors', count: 3 }]);
    conn.send({ t: 'visitors', count: -2 });
    conn.send({ t: 'visitors', count: 0 });
    await waitFor(() => h.uplink.meta().visitors === 0, 'zero');
    conn.send({ t: 'visitors', count: 1 });
    await waitFor(() => h.uplink.meta().visitors === 1, 'one');
    // the connection dropped: the count belongs to another connection, forgotten
    conn.drop();
    await waitFor(() => !h.uplink.connected, 'drop');
    expect(h.uplink.meta()).not.toHaveProperty('visitors');
  });

  it('closed to visitors: no count (the server does not even send the 0)', async () => {
    const h = await start();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first upload');
    h.world.ws.connections[0]!.send({ t: 'visitors', count: 2 });
    await waitFor(() => h.uplink.meta().visitors === 2, 'count');
    const s = h.store.get()!;
    h.store.save({ ...s, player: { ...s.player!, visibility: { ...s.player!.visibility, closed: true } } });
    expect(h.uplink.meta()).not.toHaveProperty('visitors');
    // reopened: the old count does not come back (whoever was there was put out; the server only sends when someone enters)
    h.store.save({ ...s, player: { ...s.player!, visibility: { ...s.player!.visibility, closed: false } } });
    expect(h.uplink.meta()).not.toHaveProperty('visitors');
    expect(h.uplink.status()).not.toHaveProperty('visitors');
    h.world.ws.connections[0]!.send({ t: 'visitors', count: 1 });
    await waitFor(() => h.uplink.meta().visitors === 1, 'new count');
  });
});

describe('BuildingUplink: tasks and compactions without connection', () => {
  const tasks = (done: number, pending: number) => [
    ...Array.from({ length: done }, (_, i) => ({ id: `d${i}`, title: 'done', status: 'completed' as const })),
    ...Array.from({ length: pending }, (_, i) => ({ id: `p${i}`, title: 'left', status: 'pending' as const })),
  ];
  const compaction: Activity = { id: 'c-1', at: 2, ...SPECIAL.compact() };
  const claudeMain = (u: WorldUplink) => agentsOf(u).find((a) => a.kind === 'main' && a.provider === 'claude')!;

  it('paused: the office hook counts the tasks (even with the swapped list) and the compaction that already left recent', async () => {
    const h = await start({ compactions: true });
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
    expect(claudeMain(h.world.ws.uplinks[0].uplink).tasksDone).toBe(0);
    h.store.update({ paused: true });
    await h.uplink.pause();
    const main = h.agents[0];
    // Two completed; then the TodoWrite replaces the list (what was already done goes away from it).
    main.tasks = tasks(2, 1);
    h.change();
    await sleep(60);
    main.tasks = tasks(0, 3);
    h.change();
    await sleep(60);
    // A compaction that leaves `recent` before the next upload.
    main.recent = [compaction];
    h.change();
    await sleep(60);
    main.recent = [];
    h.change();
    await sleep(60);
    expect(h.world.ws.uplinks).toHaveLength(1);
    h.store.update({ paused: undefined });
    h.uplink.resume();
    await waitFor(() => h.world.ws.uplinks.length === 2, 'resumed');
    const a = claudeMain(h.world.ws.uplinks[1].uplink);
    expect(a.tasksDone).toBe(1); // range 1–2
    expect(a.compacted).toBe(true);
  });

  it('during the office boot nothing is observed or sent; the end of the boot unlocks', async () => {
    const booting = { v: true };
    const h = await start({ booting });
    await waitFor(() => h.world.ws.connections.length === 1 && h.world.ws.hellos.length === 1, 'connected');
    await sleep(120);
    expect(h.world.ws.uplinks).toHaveLength(0);
    booting.v = false;
    h.change();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first after the boot');
  });
});

describe('BuildingUplink: goodbye, pause and resume', () => {
  it('deploy: reconnects on its own', async () => {
    const h = await start();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
    h.world.ws.connections[0].goodbye('deploy');
    await waitFor(() => h.world.ws.uplinks.length === 2, 'back');
    expect(h.goodbyes).toEqual([]);
  });

  it('deploy at every hello (world maintenance): tries again with the wait growing up to the cap, and the welcome resets it', async () => {
    const h = await start({ start: false });
    h.world.ws.options.hello = 'deploy';
    h.uplink.start();
    await waitFor(() => h.world.ws.connections.length >= 5, 'five attempts', 3_000);
    const at = h.world.ws.connections.map((c) => c.openedAt);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    // Wait of 20, 40, 80, 80 ms (random 0.5: no random draw), plus the connection time.
    expect(gaps[0]).toBeGreaterThanOrEqual(18);
    expect(gaps[1]).toBeGreaterThanOrEqual(38);
    expect(gaps[2]).toBeGreaterThanOrEqual(78);
    expect(gaps[3]).toBeGreaterThanOrEqual(78);
    expect(h.goodbyes).toEqual([]);
    expect(h.uplink.status().stopped).toBeUndefined();
    h.world.ws.options.hello = 'auto';
    await waitFor(() => h.world.ws.uplinks.length === 1, 'back');
    // After the welcome, the next drop starts again from the minimum wait.
    const n = h.world.ws.connections.length;
    h.world.ws.open[0].drop();
    await waitFor(() => h.world.ws.connections.length === n + 1, 'reconnected');
    const last = h.world.ws.connections.at(-1)!.openedAt - h.world.ws.connections.at(-2)!.openedAt;
    expect(last).toBeLessThan(400);
  });

  for (const reason of ['banned', 'suspended', 'update', 'other-device', 'deleted'] as const) {
    it(`${reason}: stops, notifies the account and shows in the status; only comes back with resume`, async () => {
      const h = await start();
      await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
      h.world.ws.connections[0].goodbye(reason);
      await waitFor(() => h.uplink.status().stopped === reason, 'stopped');
      await sleep(150);
      expect(h.world.ws.connections).toHaveLength(1);
      expect(h.goodbyes).toEqual([reason]);
      expect(h.uplink.status().connected).toBe(false);
      // In the snapshot (which also goes to the phone), only "stopped", without the reason.
      expect(h.uplink.meta().stopped).toBe(true);
      expect(JSON.stringify(h.uplink.meta())).not.toContain(reason);
      h.uplink.sync();
      await sleep(80);
      expect(h.world.ws.connections).toHaveLength(1);
      h.uplink.resume();
      await waitFor(() => h.world.ws.uplinks.length === 2, 'resumed');
      expect(h.uplink.status().stopped).toBeUndefined();
      expect(h.uplink.meta().stopped).toBeUndefined();
    });
  }

  for (const reason of ['waiting', 'no_player', 'unauthorized'] as const) {
    it(`${reason} in the hello: stops without insisting until the session changes`, async () => {
      const h = await start({ start: false });
      h.world.ws.options.hello = reason;
      h.uplink.start();
      await waitFor(() => h.goodbyes.length === 1, 'goodbye');
      expect(h.goodbyes).toEqual([reason]);
      await sleep(200);
      expect(h.world.ws.connections).toHaveLength(1);
      // The session changed (character saved again, for example): tries again.
      h.world.ws.options.hello = 'auto';
      h.store.update({ player: { ...PLAYER, updatedAt: '2026-10-16T00:00:00Z' } });
      h.uplink.sync();
      await waitFor(() => h.world.ws.uplinks.length === 1, 'came back');
    });
  }

  it('waitlist again and then approved: comes back on its own', async () => {
    const h = await start({ start: false });
    h.world.ws.options.hello = 'waiting';
    h.uplink.start();
    await waitFor(() => h.goodbyes.length === 1, 'goodbye');
    h.store.update({ access: 'waiting' });
    h.uplink.sync();
    h.world.ws.options.hello = 'auto';
    h.store.update({ access: 'approved' });
    h.uplink.sync();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'came back');
  });

  it('pause closes the connection before answering; resume reopens and sends the whole packet', async () => {
    const h = await start();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
    h.store.update({ paused: true });
    await h.uplink.pause();
    // As soon as the pause responds, the server has already seen the connection close.
    expect(h.world.ws.open).toHaveLength(0);
    expect(h.world.ws.connections[0].closedCleanly).toBe(true);
    expect(h.uplink.status()).toMatchObject({ connected: false, paused: true });
    h.change();
    await sleep(150);
    expect(h.world.ws.connections).toHaveLength(1);
    h.store.update({ paused: undefined });
    h.uplink.resume();
    await waitFor(() => h.world.ws.uplinks.length === 2, 'resumed');
    expect(h.uplink.status()).toMatchObject({ connected: true, paused: false });
  });

  it('pause with the server silent: answers in time (closeWaitMs) even without the close coming back', async () => {
    const clock = new ManualClock();
    const h = await start({ clock });
    await waitFor(() => h.uplink.status().connected, 'welcome');
    clock.advance(0);
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
    h.world.ws.options.answerClose = false;
    h.store.update({ paused: true });
    let answered = false;
    const paused = h.uplink.pause().then(() => void (answered = true));
    clock.advance(FAST.closeWaitMs! - 1);
    await sleep(30);
    expect(answered).toBe(false);
    clock.advance(1);
    await paused;
    expect(h.uplink.status().connected).toBe(false);
    // Nothing else goes out through the hanging connection.
    const before = h.world.ws.connections[0].messages.length;
    h.change();
    clock.advance(FAST.debounceMs! + FAST.minGapMs!);
    await sleep(50);
    expect(h.world.ws.connections[0].messages.length).toBe(before);
  });

  it('signing out closes right away and forgets the ids', async () => {
    const h = await start();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'first');
    const first = h.world.ws.uplinks[0].uplink;
    h.store.clear();
    h.uplink.sync();
    await waitFor(() => h.world.ws.open.length === 0, 'closed');
    h.store.save({ deviceId: 'dev_1', token: h.token, email: EMAIL, access: 'approved', player: PLAYER });
    h.uplink.sync();
    await waitFor(() => h.world.ws.uplinks.length === 2, 'back');
    // Another session: new ids.
    expect(h.world.ws.uplinks[1].uplink.floors.map((f) => f.id)).not.toEqual(first.floors.map((f) => f.id));
  });
});

describe('backoffDelay', () => {
  it('doubles from 2 s up to 60 s, with ±25 %, never above the cap', () => {
    const mid = [0, 1, 2, 3, 4, 5, 6, 10].map((n) => backoffDelay(n, () => 0.5));
    expect(mid).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    expect(backoffDelay(0, () => 0)).toBe(1_500);
    expect(backoffDelay(0, () => 1)).toBe(2_500);
    expect(backoffDelay(9, () => 1)).toBe(60_000);
    expect(backoffDelay(9, () => 0)).toBe(45_000);
  });
});
