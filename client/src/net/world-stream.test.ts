// The World scene's stream in the browser (world-stream.ts): the fake SSE (Node has no EventSource), the batches of
// commands every 200 ms with only the last move, the 429 wait, the reconnection; and the fake city of demo mode,
// deterministic (the same clock gives the same city), with everyone in a walkable place, my building on lot (3,1),
// someone sitting on a bench in the plaza, `?perf=N` and the `afk` after 60 s without walking.
import { describe, expect, it } from 'vitest';
import type { WorldSceneCommand } from '../../../shared/world/api';
import { blockAt, chunkId, chunkOf, chunksAround, isWalkable, lotDoor, lotSpiral } from '../../../shared/world/city';
import { SceneState } from '../../../shared/world/scene';
import { plazaDecor } from '../world/city/layout';
import { MoveSender } from '../world/city/players';
import { CityState } from '../world/city/state';
import type { EventSourceLike } from './store';
import {
  CMD_BATCH_MS,
  FAKE_ME,
  createWorldStream,
  enqueueCommands,
  fakeBenchSeat,
  fakeMyDoor,
  fakeCityBuildings,
  FakeWorldStream,
  HttpWorldStream,
  loopPosition,
  type WorldStreamEvent,
} from './world-stream';

class FakeES implements EventSourceLike {
  readyState = 0;
  closed = false;
  private readonly handlers = new Map<string, Array<(ev: Event) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (ev: Event) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(listener);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  fire(type: string, data?: unknown): void {
    const ev = { data: data === undefined ? undefined : JSON.stringify(data) } as unknown as Event;
    for (const h of this.handlers.get(type) ?? []) h(ev);
  }
}

/** Clock and timers by hand. */
function clock() {
  let t = 1_000;
  let seq = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    now: () => t,
    setTimeout: (cb: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, cb });
      return id;
    },
    clearTimeout: (id: unknown) => void timers.delete(id as number),
    async advance(ms: number) {
      const until = t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].cb();
        await new Promise((ok) => setTimeout(ok, 0));
      }
      t = until;
      await new Promise((ok) => setTimeout(ok, 0));
    },
    pending: () => timers.size,
  };
}

function httpSetup(replies: Array<{ status: number; body?: unknown }> = []) {
  const c = clock();
  const sources: FakeES[] = [];
  const posts: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init?.body)) });
    const r = replies.shift() ?? { status: 202, body: { sent: 1 } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  const ws = new HttpWorldStream({
    eventSource: (url) => {
      const es = new FakeES(url);
      sources.push(es);
      return es;
    },
    fetch: fetchImpl,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    now: c.now,
  });
  const events: WorldStreamEvent[] = [];
  ws.on((e) => events.push(e));
  const snap = (stream = 'st1') => ({ stream, connected: true, viewing: true, afk: false, chunks: [], players: [], minimap: null });
  return { c, ws, sources, posts, events, snap };
}

const move = (x: number): WorldSceneCommand => ({ t: 'move', x, y: 15, dir: 'e', moving: true });

describe('enqueueCommands', () => {
  it('the last move replaces the others; the rest stays up to the cap, the oldest leaving', () => {
    expect(enqueueCommands([move(1), { t: 'like', buildingId: 'b' }], [move(2)])).toEqual([{ t: 'like', buildingId: 'b' }, move(2)]);
    const many = Array.from({ length: 30 }, (_, i) => ({ t: 'profile' as const, playerId: `p${i}` }));
    const q = enqueueCommands([], [...many, move(3)]);
    expect(q).toHaveLength(20);
    expect(q[0]).toEqual({ t: 'profile', playerId: 'p11' });
    expect(q.at(-1)).toEqual(move(3));
  });
});

describe('HttpWorldStream', () => {
  it('opens /api/world/stream; snapshot and scene messages become events; what is not from the scene stays', () => {
    const { sources, events, snap } = httpSetup();
    expect(sources[0]?.url).toBe('/api/world/stream');
    sources[0]!.fire('world.snapshot', snap());
    sources[0]!.fire('world', { t: 'pos', x: 21, y: 15 });
    sources[0]!.fire('world', { t: 'uplink.ack', at: 1 });
    sources[0]!.fire('world', 'crooked');
    expect(events).toEqual([
      { type: 'status', status: 'open' },
      { type: 'snapshot', snapshot: snap() },
      { type: 'message', msg: { t: 'pos', x: 21, y: 15 } },
    ]);
  });

  it('commands in batches: one every 200 ms, with the stream id, only the last move; nothing before the snapshot', async () => {
    const { c, ws, sources, posts, snap } = httpSetup();
    ws.send([move(1)]);
    await c.advance(1_000);
    expect(posts).toEqual([]);
    sources[0]!.fire('world.snapshot', snap('abc'));
    await c.advance(0);
    expect(posts).toEqual([{ url: '/api/world/cmd', body: { stream: 'abc', cmds: [move(1)] } }]);
    ws.send([move(2)]);
    ws.send([{ t: 'profile', playerId: 'p1' }, move(3)]);
    await c.advance(CMD_BATCH_MS - 1);
    expect(posts).toHaveLength(1);
    await c.advance(1);
    expect(posts[1]?.body).toEqual({ stream: 'abc', cmds: [{ t: 'profile', playerId: 'p1' }, move(3)] });
  });

  it('429: the batch goes back to the queue and waits for the Retry-After; other errors become an event', async () => {
    const { c, ws, sources, posts, events, snap } = httpSetup([
      { status: 429, body: { error: { code: 'rate_limited', retryAfter: 1 } } },
      { status: 202 },
      { status: 409, body: { error: { code: 'not_connected' } } },
    ]);
    sources[0]!.fire('world.snapshot', snap());
    ws.send([move(1)]);
    await c.advance(0);
    expect(posts).toHaveLength(1);
    ws.send([{ t: 'like', buildingId: 'b1' }]);
    await c.advance(999);
    expect(posts).toHaveLength(1);
    await c.advance(1);
    expect(posts[1]?.body.cmds).toEqual([move(1), { t: 'like', buildingId: 'b1' }]);
    ws.send([move(5)]);
    await c.advance(CMD_BATCH_MS);
    expect(events.at(-1)).toEqual({ type: 'error', code: 'not_connected' });
  });

  it('the browser gave up on the stream (closed): reopens with a growing wait; the new snapshot brings another id', async () => {
    const { c, ws, sources, posts, events, snap } = httpSetup();
    sources[0]!.fire('world.snapshot', snap('s1'));
    sources[0]!.readyState = 2;
    sources[0]!.fire('error');
    expect(events.at(-1)).toEqual({ type: 'status', status: 'retrying' });
    ws.send([move(1)]);
    await c.advance(1_999);
    expect(sources).toHaveLength(1);
    await c.advance(1);
    expect(sources).toHaveLength(2);
    expect(posts).toEqual([]);
    sources[1]!.fire('world.snapshot', snap('s2'));
    await c.advance(0);
    expect(posts[0]?.body.stream).toBe('s2');
    // Still connecting (the browser itself retries): only the status changes.
    sources[1]!.fire('error');
    expect(events.at(-1)).toEqual({ type: 'status', status: 'connecting' });
    ws.close();
    expect(sources[1]!.closed).toBe(true);
    expect(c.pending()).toBe(0);
  });
});

describe('FakeWorldStream (demo mode)', () => {
  const district = 'centro';
  const door = fakeMyDoor();
  const around = new Set(chunksAround(chunkOf(blockAt(door.x, door.y))).map((ch) => chunkId(district, ch)));
  const first = (n: number) => {
    const out: Array<{ x: number; y: number }> = [];
    for (const lot of lotSpiral()) {
      if (out.length >= n) break;
      out.push(lot);
    }
    return out;
  };

  it('back to the city: view.off + view and a new stream from the same page spawn at the last position (with no memory, at the door)', () => {
    const memory = {};
    const a = new FakeWorldStream({ autoplay: false, now: () => 0, memory });
    const to = { x: door.x + 2, y: door.y };
    expect(isWalkable(to.x, to.y, () => true)).toBe(true);
    a.send([{ t: 'view' }, { t: 'move', x: to.x, y: to.y, dir: 'e', moving: false }]);
    // the same stream: view.off and view again
    a.send([{ t: 'view.off' }, { t: 'view' }]);
    expect(a.snapshot().pos).toEqual({ x: to.x, y: to.y, dir: 'e', moving: false });
    // closed the scene (the stream closes) and opened it again: a new stream, with the same memory
    a.close();
    const b = new FakeWorldStream({ autoplay: false, now: () => 0, memory });
    expect(b.snapshot().pos).toEqual({ x: to.x, y: to.y, dir: 'e', moving: false });
    // without the memory (another page, the tests), spawns at the door, as always
    expect(new FakeWorldStream({ autoplay: false, now: () => 0 }).snapshot().pos).toEqual({ x: door.x, y: door.y, dir: 's', moving: false });
  });

  it('20 buildings in the first lots of the spiral, mine at (3,1); I spawn on the sidewalk at my door', () => {
    const b = fakeCityBuildings();
    expect(b.map((x) => ({ x: x.lot.x, y: x.lot.y }))).toEqual(first(20));
    const mine = b.find((x) => x.id === FAKE_ME.id)!;
    expect(mine.lot).toMatchObject({ x: 3, y: 1 });
    expect(mine.owner).toMatchObject({ id: FAKE_ME.id, name: 'Pixel Dev' });
    expect(door).toEqual(lotDoor({ x: 3, y: 1 }).front);
    expect(isWalkable(door.x, door.y, () => true)).toBe(true);
    expect(new Set(b.map((x) => x.theme))).toEqual(new Set(['none', 'halloween', 'christmas']));
    expect(b.some((x) => x.state === 'away')).toBe(true);
    expect(b.some((x) => !x.agents)).toBe(true);
    expect(b.some((x) => x.floors > 12)).toBe(true);
    const s = new FakeWorldStream({ autoplay: false, now: () => 0 }).snapshot();
    expect(s.chunks.reduce((n, c) => n + c.buildings.length, 0)).toBe(20);
    for (const c of s.chunks) expect(around.has(c.chunk), c.chunk).toBe(true);
    expect(s.me).toEqual(FAKE_ME);
    expect(s.me?.buildingId).toBe(mine.id);
    expect(s.pos).toEqual({ x: door.x, y: door.y, dir: 's', moving: false });
    expect(s.players).toHaveLength(6);
    for (const p of s.players) expect(isWalkable(p.pos.x, p.pos.y, () => true), p.id).toBe(true);
    // whoever has a building in the fake city: the player's id is the building's, with the same name
    for (const p of s.players.filter((x) => x.buildingId)) expect(b.find((x) => x.id === p.buildingId)?.owner.name).toBe(p.name);
    expect(s.minimap?.reduce((n, m) => n + m.lit, 0)).toBe(b.filter((x) => x.state === 'online').length);
    // The demo mode names are fake nicknames, never the name of the person using it.
    expect(b.every((x) => / /.test(x.owner.name))).toBe(true);
    // the scene reads the snapshot as it comes
    const st = new CityState();
    st.applySnapshot(s, 0);
    expect(st.buildings.size).toBe(20);
    expect(st.myBuilding()?.lot).toMatchObject({ x: 3, y: 1 });
    expect(st.startPos).toEqual({ x: door.x, y: door.y });
  });

  it('the 6th player stays still on a plaza bench seat (the scene draws them seated)', () => {
    const s = new FakeWorldStream({ autoplay: false, now: () => 0 });
    const seat = fakeBenchSeat();
    expect(plazaDecor().some((d) => d.seat && d.seat.x === seat.x && d.seat.y === seat.y)).toBe(true);
    const sitter = s.snapshot().players[5]!;
    expect(sitter.pos).toEqual({ x: seat.x, y: seat.y, dir: 's', moving: false });
    const msgs: any[] = [];
    s.on((e) => e.type === 'message' && msgs.push(e.msg));
    for (let i = 0; i < 20; i++) s.tick();
    expect(msgs.filter((m) => m.t === 'players').flatMap((m) => m.players.map((p: { id: string }) => p.id))).not.toContain(sitter.id);
  });

  it('?perf=N: N buildings in the spiral, with numbered names and still mine', () => {
    const b = fakeCityBuildings(300);
    expect(b).toHaveLength(300);
    expect(new Set(b.map((x) => x.id)).size).toBe(300);
    expect(b.filter((x) => x.id === FAKE_ME.id)).toHaveLength(1);
    expect(b.some((x) => / 2$/.test(x.owner.name))).toBe(true);
    expect(new FakeWorldStream({ autoplay: false, now: () => 0, buildings: 300 }).snapshot().chunks.reduce((n, c) => n + c.buildings.length, 0)).toBe(300);
    expect(fakeCityBuildings(5_000)).toHaveLength(2000);
  });

  it('afk after 60 s without walking; a real step clears it', async () => {
    let t = 0;
    const f = new FakeWorldStream({ autoplay: false, now: () => t });
    const msgs: any[] = [];
    f.on((e) => e.type === 'message' && msgs.push(e.msg));
    await Promise.resolve();
    t = 59_000;
    f.tick();
    expect(msgs.some((m) => m.t === 'afk')).toBe(false);
    t = 60_000;
    f.tick();
    expect(msgs.filter((m) => m.t === 'afk')).toHaveLength(1);
    expect(f.snapshot().afk).toBe(true);
    f.send([{ t: 'move', x: door.x + 1, y: door.y, dir: 'e', moving: true }]);
    expect(f.snapshot().afk).toBe(false);
  });

  it('deterministic: the same clock gives the same city and the same steps', () => {
    const run = () => {
      let t = 0;
      const f = new FakeWorldStream({ autoplay: false, now: () => t });
      const out: unknown[] = [];
      f.on((e) => e.type === 'message' && out.push(e.msg));
      for (let i = 0; i < 40; i++) {
        t += 200;
        f.tick();
      }
      return { snap: f.snapshot(), out };
    };
    expect(run()).toEqual(run());
  });

  it('the 5 walk around the blocks, always in a walkable place and in the chunks of the view; the state keeps up without resync', async () => {
    let t = 0;
    const f = new FakeWorldStream({ autoplay: false, now: () => t });
    let state: SceneState | undefined;
    let resyncs = 0;
    f.on((e) => {
      if (e.type === 'snapshot') state = SceneState.fromSnapshot(e.snapshot);
      if (e.type === 'message' && state && state.apply(e.msg as unknown as Record<string, unknown>).resync) resyncs++;
    });
    await Promise.resolve();
    expect(state).toBeDefined();
    for (let i = 0; i < 400; i++) {
      t += 200;
      f.tick();
      for (const p of f.snapshot().players) {
        expect(isWalkable(p.pos.x, p.pos.y, () => true), `${p.id} at ${p.pos.x},${p.pos.y}`).toBe(true);
        expect(around.has(chunkId(district, chunkOf(blockAt(p.pos.x, p.pos.y))))).toBe(true);
      }
    }
    expect(resyncs).toBe(0);
    expect(state!.player('p_1')?.pos).toEqual(f.snapshot().players[0]?.pos);
    // Every 3 s a building changes (area.patch with rev + 1), and the applied state matches the fake's.
    const fromFake = f.snapshot().chunks.map((c) => [c.chunk, c.rev]);
    expect(fromFake.map(([c]) => [c, state!.chunkRev(c as string)])).toEqual(fromFake);
    expect(fromFake.some(([, rev]) => (rev as number) > 1)).toBe(true);
    // Goes around: after 80 s none of the 5 is where they started.
    const start = new FakeWorldStream({ autoplay: false, now: () => 0 }).snapshot().players;
    for (const [i, p] of f.snapshot().players.slice(0, 5).entries()) expect(p.pos).not.toEqual(start[i]?.pos);
  });

  it('loopPosition: the full lap closes at the same point, in both directions', () => {
    const b = { x: 1, y: 0 };
    const len = 2 * (44 + 26);
    expect(loopPosition(b, 0, true)).toMatchObject({ x: 50, y: -1, dir: 'e' });
    expect(loopPosition(b, len, true)).toMatchObject({ x: 50, y: -1 });
    expect(loopPosition(b, 1, false)).toMatchObject({ x: 50, y: 0, dir: 's' });
  });

  it('commands: move to a lot or too far comes back as pos; profile, like and resync answer on the next step', async () => {
    let t = 0;
    const f = new FakeWorldStream({ autoplay: false, now: () => t });
    const msgs: any[] = [];
    f.on((e) => e.type === 'message' && msgs.push(e.msg));
    await Promise.resolve();
    f.send([{ t: 'move', x: door.x + 1, y: door.y, dir: 'e', moving: true }]);
    f.send([{ t: 'move', x: 60, y: 5, dir: 'e', moving: true }]); // inside a lot
    f.send([{ t: 'move', x: 21, y: 15, dir: 'e', moving: true }]); // too far (the plaza)
    f.send([{ t: 'profile', playerId: 'p_2' }, { t: 'profile', playerId: 'nobody' }, { t: 'like', buildingId: 'b_000' }, { t: 'resync', chunk: 'centro:0,0' }]);
    expect(msgs).toEqual([]);
    t += 200;
    f.tick();
    const types = msgs.map((m) => m.t);
    expect(types.slice(0, 6)).toEqual(['pos', 'pos', 'profile', 'notice', 'notice', 'area']);
    expect(msgs[0]).toEqual({ t: 'pos', x: door.x + 1, y: door.y });
    expect(msgs[2].player.id).toBe('p_2');
    expect(msgs[3]).toEqual({ t: 'notice', level: 'info', text: 'not_found' });
    // like far from the door (b_000 is on the other side of the block): like the server, it refuses
    expect(msgs[4]).toEqual({ t: 'notice', level: 'warn', text: 'too_far' });
    expect(msgs[5].chunk).toBe('centro:0,0');
  });

  it('right at the edge of a lot, the truncated position from the wire stays on the sidewalk (no `pos`)', async () => {
    const f = new FakeWorldStream({ autoplay: false, now: () => 0 });
    const msgs: any[] = [];
    f.on((e) => e.type === 'message' && msgs.push(e.msg));
    await Promise.resolve();
    // me on the west sidewalk of block (1,0), right next to lot (3,0): x = 51 − 0.004
    f.send([{ t: 'move', x: door.x - 5, y: door.y, dir: 'w', moving: true }]);
    f.send([{ t: 'move', x: 52, y: door.y, dir: 'w', moving: true }]);
    f.send([{ t: 'move', x: 50.5, y: 24, dir: 'n', moving: true }]);
    const sent: WorldSceneCommand[] = [];
    new MoveSender((m) => sent.push(m)).tick(0, { x: 50.996, y: 20, dir: 'up', moving: false });
    f.send(sent);
    f.tick();
    expect(sent[0]).toMatchObject({ x: 50.99, y: 20 });
    expect(msgs.filter((m) => m.t === 'pos')).toEqual([]);
  });

  it('visit (Phase 4): far away and closed refuse; mine from anywhere; inside nothing from the street comes down, patches every 3 s; leave returns to the door', async () => {
    let t = 0;
    const f = new FakeWorldStream({ autoplay: false, now: () => t });
    const msgs: any[] = [];
    f.on((e) => e.type === 'message' && msgs.push(e.msg));
    await Promise.resolve();
    const all = fakeCityBuildings();
    const other = all.find((b) => b.id !== FAKE_ME.id && b.state === 'online' && b.agents && !b.closed)!;
    const closed = all.find((b) => b.closed)!;
    f.send([{ t: 'enter', buildingId: other.id }]);
    f.send([{ t: 'enter', buildingId: 'does_not_exist' }]);
    f.tick();
    expect(msgs.filter((m) => m.t === 'notice').map((m) => m.text)).toEqual(['too_far', 'not_found']);
    // closed, even at the door
    const door = lotDoor(closed.lot).front;
    (f as unknown as { me: object }).me = { x: door.x, y: door.y, dir: 'n', moving: false };
    f.send([{ t: 'enter', buildingId: closed.id }]);
    f.tick();
    expect(msgs.filter((m) => m.t === 'notice').at(-1)).toMatchObject({ t: 'notice', text: 'closed' });
    // my building, from anywhere ("see it as others do"); the owner does not count as a visitor
    msgs.length = 0;
    f.send([{ t: 'enter', buildingId: FAKE_ME.id }]);
    f.tick();
    expect(msgs[0]).toMatchObject({ t: 'building', rev: 1, detail: { building: { id: FAKE_ME.id, owner: { name: FAKE_ME.name } }, visitors: 0 } });
    expect(msgs[0].detail.floors).toHaveLength(3);
    expect(f.snapshot().inside).toMatchObject({ id: FAKE_ME.id, rev: 1 });
    expect(f.snapshot().players).toEqual([]);
    // 3 s: a patch with the next rev (and no players, area or minimap)
    msgs.length = 0;
    for (let i = 0; i < 30; i++) f.tick();
    expect(msgs.map((m) => m.t)).toEqual(['building.patch', 'building.patch']);
    expect(msgs.map((m) => m.rev)).toEqual([2, 3]);
    // leave: pos at the door and the areas again
    msgs.length = 0;
    f.send([{ t: 'leave' }]);
    f.tick();
    const mine = lotDoor(all.find((b) => b.id === FAKE_ME.id)!.lot).front;
    expect(msgs[0]).toEqual({ t: 'pos', x: mine.x, y: mine.y });
    const areas = msgs.filter((m) => m.t === 'area');
    expect(areas.length).toBeGreaterThan(0);
    expect(msgs.findIndex((m) => m.t === 'area')).toBe(1);
    expect(f.snapshot().inside).toBeUndefined();
  });

  it('visit: the sample interior follows the building (discreet: no agents and `discreet`; off: `away`)', async () => {
    const f = new FakeWorldStream({ autoplay: false, now: () => 0 });
    const msgs: any[] = [];
    f.on((e) => e.type === 'message' && msgs.push(e.msg));
    await Promise.resolve();
    const all = fakeCityBuildings();
    for (const [b, check] of [
      [all.find((x) => x.state === 'online' && !x.agents && !x.closed)!, (d: any) => d.building.discreet === true && d.floors.every((fl: any) => !fl.agents.length)],
      [all.find((x) => x.state === 'away' && !x.closed)!, (d: any) => d.building.state === 'away' && d.floors.every((fl: any) => !fl.agents.length)],
    ] as const) {
      const door = lotDoor(b.lot).front;
      (f as unknown as { me: object }).me = { x: door.x, y: door.y, dir: 'n', moving: false };
      f.send([{ t: 'enter', buildingId: b.id }]);
      f.tick();
      const d = msgs.findLast((m) => m.t === 'building').detail;
      expect(d.building.id).toBe(b.id);
      expect(check(d)).toBe(true);
      f.send([{ t: 'leave' }]);
      f.tick();
    }
  });

  it('createWorldStream: mock gives the fake city; close stops everything', async () => {
    const ws = createWorldStream({ mock: true, autoplay: false });
    expect(ws).toBeInstanceOf(FakeWorldStream);
    const evs: WorldStreamEvent[] = [];
    ws.on((e) => evs.push(e));
    ws.close();
    await Promise.resolve();
    expect(evs).toEqual([{ type: 'status', status: 'closed' }]);
  });

  describe('light social (Phase 5)', () => {
    const start = async (t = { v: 0 }) => {
      const f = new FakeWorldStream({ autoplay: false, now: () => t.v });
      const msgs: any[] = [];
      f.on((e) => e.type === 'message' && msgs.push(e.msg));
      await Promise.resolve();
      return { f, msgs, t };
    };
    const doorOf = (id: string) => lotDoor(fakeCityBuildings().find((b) => b.id === id)!.lot).front;
    /** Takes the fake's "me" to the door (short steps, like the MoveSender). */
    const walkTo = (f: FakeWorldStream, to: { x: number; y: number }) => {
      let { x, y } = f.snapshot().pos!;
      while (Math.hypot(to.x - x, to.y - y) > 0.01) {
        const d = Math.hypot(to.x - x, to.y - y);
        const k = Math.min(1, 4 / d);
        x += (to.x - x) * k;
        y += (to.y - y) * k;
        f.send([{ t: 'move', x, y, dir: 'e', moving: true }]);
      }
    };

    it('the buildings have a code (mine is HB-4F2K), some accept knocks and one is "unverified"; the snapshot brings the goal at 80 %', () => {
      const b = fakeCityBuildings();
      expect(b.find((x) => x.id === FAKE_ME.id)?.code).toBe('HB-4F2K');
      expect(new Set(b.map((x) => x.code)).size).toBe(20);
      for (const x of b) expect(x.code).toMatch(/^HB-[2-9A-HJKMNP-TV-Z]{4}$/);
      expect(b.some((x) => x.knocks)).toBe(true);
      expect(b.filter((x) => (x as { unverified?: boolean }).unverified)).toHaveLength(1);
      const city = new FakeWorldStream({ autoplay: false, now: () => Date.UTC(2026, 9, 15) }).snapshot().city!;
      expect(city).toMatchObject({ lit: b.filter((x) => x.state === 'online').length, tokensBand: 4, goal: { label: 'agent_hours_10k', target: 10_000, progress: 8_000, id: '2026-10-12:agent_hours_10k' } });
    });

    it('like only near the door and never on mine; stamp once; knocking from far away is refused', async () => {
      const { f, msgs } = await start();
      f.send([{ t: 'like', buildingId: FAKE_ME.id }]);
      walkTo(f, doorOf('b_004'));
      f.send([{ t: 'like', buildingId: 'b_004' }, { t: 'stamp', buildingId: 'b_004', stampId: 'star' }, { t: 'stamp', buildingId: 'b_004', stampId: 'rocket' }, { t: 'knock', buildingId: 'b_000' }]);
      f.tick();
      const out = msgs.filter((m) => m.t !== 'players' && m.t !== 'greeting');
      expect(out).toEqual([
        { t: 'notice', level: 'warn', text: 'invalid' },
        { t: 'like.update', buildingId: 'b_004', likes: expect.any(Number), likedByMe: true },
        // like the server: the stamp that counted answers `stamped`; the second one of the day, `already_done`
        { t: 'notice', level: 'info', text: 'stamped' },
        { t: 'notice', level: 'info', text: 'already_done' },
        { t: 'notice', level: 'warn', text: 'too_far' },
      ]);
    });

    it('inside the building (visit), like and stamp count; block and report answer blocked_ok and reported', async () => {
      const { f, msgs } = await start();
      walkTo(f, doorOf('b_004'));
      f.send([{ t: 'enter', buildingId: 'b_004' }]);
      f.tick();
      expect(f.snapshot().inside?.id).toBe('b_004');
      const n = msgs.length;
      f.send([
        { t: 'like', buildingId: 'b_004' },
        { t: 'stamp', buildingId: 'b_004', stampId: 'coffee' },
        { t: 'block', playerId: 'p_3' },
        { t: 'report', playerId: 'p_4', reason: 'other' },
      ]);
      f.tick();
      expect(msgs.slice(n).filter((m) => m.t !== 'players' && m.t !== 'greeting' && m.t !== 'building.patch')).toEqual([
        { t: 'like.update', buildingId: 'b_004', likes: expect.any(Number), likedByMe: true },
        { t: 'notice', level: 'info', text: 'stamped' },
        { t: 'player.leave', id: 'p_3' },
        { t: 'notice', level: 'info', text: 'blocked_ok' },
        { t: 'notice', level: 'info', text: 'reported' },
      ]);
    });

    it('greeting a bot: the echo and its reply in 1.2 s; blocking takes it off the street and unblocking brings it back', async () => {
      const { f, msgs, t } = await start();
      f.send([{ t: 'greet', playerId: 'p_2', greetingId: 'coffee' }]);
      f.tick();
      expect(msgs.filter((m) => m.t === 'greeting')[0]).toMatchObject({ from: FAKE_ME.id, to: 'p_2', greetingId: 'coffee' });
      t.v += 1_300;
      f.tick();
      expect(msgs.filter((m) => m.t === 'greeting' && m.from === 'p_2' && m.to === FAKE_ME.id)).toHaveLength(1);
      f.send([{ t: 'block', playerId: 'p_2' }]);
      f.tick();
      expect(msgs).toContainEqual({ t: 'player.leave', id: 'p_2' });
      expect(f.snapshot().players.map((p) => p.id)).not.toContain('p_2');
      f.send([{ t: 'greet', playerId: 'p_2', greetingId: 'hello' }, { t: 'unblock', playerId: 'p_2' }]);
      f.tick();
      expect(msgs.filter((m) => m.t === 'notice' || m.t === 'player.join').slice(-2)).toMatchObject([{ t: 'notice', text: 'not_found' }, { t: 'player.join', player: { id: 'p_2' } }]);
    });

    it('the bots greet each other every 5 s, and the other one replies', async () => {
      const { f, msgs, t } = await start();
      for (let i = 0; i < 25; i++) {
        t.v += 200;
        f.tick();
      }
      const g = msgs.filter((m) => m.t === 'greeting');
      expect(g.length).toBeGreaterThanOrEqual(1);
      t.v += 2_000;
      f.tick();
      const replies = msgs.filter((m) => m.t === 'greeting' && m.from === g[0].to && m.to === g[0].from);
      expect(replies).toHaveLength(1);
    });

    it('go to a code: pos on the sidewalk at the door (and the "me" of the fake goes along); code that does not exist: not_found', async () => {
      const { f, msgs } = await start();
      const target = fakeCityBuildings()[12]!;
      f.send([{ t: 'teleport', code: target.code!.toLowerCase().replace('-', ' ') }, { t: 'teleport', code: 'HB-ZZZZ' }]);
      f.tick();
      const front = lotDoor(target.lot).front;
      expect(msgs.find((m) => m.t === 'pos')).toEqual({ t: 'pos', x: front.x, y: front.y });
      expect(msgs.some((m) => m.t === 'area')).toBe(true);
      expect(msgs.filter((m) => m.t === 'notice')).toEqual([{ t: 'notice', level: 'info', text: 'not_found' }]);
      // the next step, near the new door, is accepted (with no correction `pos`)
      const n = msgs.length;
      f.send([{ t: 'move', x: front.x + 1, y: front.y, dir: 'e', moving: true }]);
      f.tick();
      expect(msgs.slice(n).filter((m) => m.t === 'pos')).toEqual([]);
      // random: a lit building that is not mine
      f.send([{ t: 'teleport' }]);
      f.tick();
      const last = msgs.filter((m) => m.t === 'pos').pop();
      const lit = fakeCityBuildings().filter((b) => b.state === 'online' && b.id !== FAKE_ME.id).map((b) => lotDoor(b.lot).front);
      expect(lit).toContainEqual({ x: last.x, y: last.y });
    });

    it('celebrate: fireworks and the next goal (50 thousand h)', async () => {
      const { f, msgs } = await start({ v: Date.UTC(2026, 9, 15) });
      f.celebrate();
      expect(msgs[0]).toEqual({ t: 'city.fireworks', goalId: '2026-10-12:agent_hours_10k' });
      expect(msgs[1]).toMatchObject({ t: 'city', goal: { label: 'agent_hours_50k', target: 50_000, progress: 10_000, id: '2026-10-12:agent_hours_50k' } });
    });
  });
});
