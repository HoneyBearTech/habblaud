// The World scene in the browser (Phase 3): the city's stream (GET /api/world/stream, SSE) and the player's commands
// (POST /api/world/cmd), plus a FakeWorldStream for demo mode (?mock=1&world=approved&scene=city) and the
// tests. The scene uses only `createWorldStream({mock})`:
//
//   const ws = createWorldStream({ mock: store.mock });
//   const off = ws.on((ev) => { ... });   // 'snapshot' (replaces the whole state), 'message' (applies in order), 'status'
//   ws.send([{ t: 'move', x, y, dir, moving }]);  // queue: one batch every 200 ms, only the last move of each batch
//   ws.close();                                    // closes the SSE (the local server sends `view.off` if it was the last)
//
// The local server has already checked the `rev` of the patches and dropped what does not belong to the scene: the
// browser applies each `message` in the order it arrives (the scene uses client/src/world/city/state.ts, starting from
// the snapshot). The world server is never called from here, and the token never reaches the page.
//
// The fake city (only fictitious data, nothing from the office): 20 buildings on the first lots of the spiral, mine on
// lot (3,1) with the door on the south sidewalk (where I spawn, as the server does), 5 people going around the blocks
// and one sitting on a bench in the plaza, a building changing every 3 s and the `afk` after 60 s without walking;
// `?perf=N` fills N lots.
// Visit (Phase 4): `enter` at the door (within 3 tiles, like the server; my building from anywhere) answers with the
// sample interior (shared/world/visit-sample.ts: live, discreet or off, depending on the building), a
// `building.patch` every 3 s (agents changing status) and the visitor count; closed to visits, `closed`;
// far away, `too_far`. Inside, nothing from the street comes down; `leave` answers the `pos` at the door and the areas
// again.
// The light social features (Phase 5), with the server's rules: like within 4 steps of the door (never on mine), stamp
// and knock within 2 (like and stamp also from inside the building), one stamp per building per day (with the
// `stamped`, like the `blocked_ok` and the `reported` of the block and the report), the bots greeting each other (and
// answering whoever greets them), blocking takes the person off the street, "Go to HB-XXXX" and the random building,
// the city goal at 80 % and, with `celebrate()` (the test button of `?fireworks=1`), the fireworks.
import type { WorldSceneCommand, WorldSceneMe, WorldSceneMessage, WorldSceneSnapshot } from '../../../shared/world/api';
import { WORLD_SCENE_LIMITS, WORLD_SCENE_MESSAGES } from '../../../shared/world/api';
import { flattenAppearance } from '../../../shared/world/appearance-flat';
import { mulberry32 } from '../../../shared/hash';
import {
  BLOCK_TILES,
  FOUNTAIN,
  PLAZA,
  blockAt,
  blockOf,
  blockOrigin,
  chunkId,
  chunkOf,
  isWalkable,
  lotDoor,
  lotSpiral,
  spawnPoint,
  type CityPoint,
} from '../../../shared/world/city';
import type {
  CityGoal,
  Direction,
  GreetingId,
  WorldBuildingDetail,
  IntroId,
  TokenBand,
  TraitId,
  WorldBuildingPublic,
  WorldPlayerPublic,
  WorldPosition,
  WorldTheme,
} from '../../../shared/world/protocol';
import { GREETING_IDS } from '../../../shared/world/protocol';
import { reduceSceneBatch } from '../../../shared/world/scene';
import { sampleBuildingDetail } from '../../../shared/world/visit-sample';
import { reconnectDelay, type EventSourceLike } from './store';
import { FAKE_SUMMARY } from './world';

export type { WorldSceneCommand, WorldSceneMessage, WorldSceneSnapshot } from '../../../shared/world/api';

/** connecting: opening (or the browser trying again); open: snapshot received; retrying: waiting to reopen. */
export type WorldStreamStatus = 'connecting' | 'open' | 'retrying' | 'closed';

export type WorldStreamEvent =
  | { type: 'snapshot'; snapshot: WorldSceneSnapshot }
  | { type: 'message'; msg: WorldSceneMessage }
  | { type: 'status'; status: WorldStreamStatus }
  /** A batch of commands refused by the local server (`no_stream`, `not_connected`, `invalid`...). */
  | { type: 'error'; code: string };

export interface WorldStream {
  on(listener: (ev: WorldStreamEvent) => void): () => void;
  send(cmds: WorldSceneCommand[]): void;
  close(): void;
}

/** One batch every 200 ms (the local server accepts 5 per second per stream). */
export const CMD_BATCH_MS = 200;
/** Commands kept in the queue while the stream does not open (apart from the last move). */
const QUEUE_MAX = WORLD_SCENE_LIMITS.cmdsPerBatch - 1;
/** EventSource.CLOSED (EventSource does not exist in the Node of the tests). */
const ES_CLOSED = 2;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Adds new commands to the queue: the last move replaces the earlier ones; the rest, up to the cap (the oldest go). */
export function enqueueCommands(queue: readonly WorldSceneCommand[], cmds: readonly WorldSceneCommand[]): WorldSceneCommand[] {
  const all = reduceSceneBatch([...queue, ...cmds]);
  const others: WorldSceneCommand[] = all.filter((c) => c.t !== 'move');
  const kept = new Set<WorldSceneCommand>(others.slice(Math.max(0, others.length - QUEUE_MAX)));
  return all.filter((c) => c.t === 'move' || kept.has(c));
}

class Listeners {
  private readonly set = new Set<(ev: WorldStreamEvent) => void>();
  add(cb: (ev: WorldStreamEvent) => void): () => void {
    this.set.add(cb);
    return () => void this.set.delete(cb);
  }
  emit(ev: WorldStreamEvent): void {
    for (const cb of [...this.set]) {
      try {
        cb(ev);
      } catch (err) {
        console.error('[world-stream]', err);
      }
    }
  }
  clear(): void {
    this.set.clear();
  }
}

// ------------------------------------------------------------------------------------------------ the real one

export interface HttpWorldStreamOptions {
  eventSource?: (url: string) => EventSourceLike;
  fetch?: typeof fetch;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  now?: () => number;
  base?: string;
}

export class HttpWorldStream implements WorldStream {
  private readonly listeners = new Listeners();
  private readonly open: (url: string) => EventSourceLike;
  private readonly fetchImpl: typeof fetch;
  private readonly setT: (cb: () => void, ms: number) => unknown;
  private readonly clearT: (t: unknown) => void;
  private readonly now: () => number;
  private readonly base: string;
  private es: EventSourceLike | null = null;
  private stream: string | null = null;
  private queue: WorldSceneCommand[] = [];
  private flushTimer: unknown = null;
  private retryTimer: unknown = null;
  private inflight = false;
  private lastPostAt = -Infinity;
  /** Wait requested by the local server (429). */
  private holdUntil = 0;
  private attempts = 0;
  private closed = false;
  private status: WorldStreamStatus = 'connecting';

  constructor(o: HttpWorldStreamOptions = {}) {
    this.open = o.eventSource ?? ((url) => new EventSource(url));
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.setT = o.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearT = o.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.now = o.now ?? Date.now;
    this.base = o.base ?? '/api/world';
    this.connect();
  }

  on(listener: (ev: WorldStreamEvent) => void): () => void {
    return this.listeners.add(listener);
  }

  send(cmds: WorldSceneCommand[]): void {
    if (this.closed || !cmds.length) return;
    this.queue = enqueueCommands(this.queue, cmds);
    this.schedule();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.es?.close();
    this.es = null;
    if (this.flushTimer) this.clearT(this.flushTimer);
    if (this.retryTimer) this.clearT(this.retryTimer);
    this.flushTimer = this.retryTimer = null;
    this.queue = [];
    this.setStatus('closed');
    this.listeners.clear();
  }

  private setStatus(s: WorldStreamStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.listeners.emit({ type: 'status', status: s });
  }

  private connect(): void {
    if (this.closed) return;
    this.stream = null;
    let es: EventSourceLike;
    try {
      es = this.open(`${this.base}/stream`);
    } catch {
      return this.retry();
    }
    this.es = es;
    const current = () => this.es === es && !this.closed;
    es.addEventListener('world.snapshot', (ev) => {
      if (!current()) return;
      const snap = parse(ev);
      if (!isObj(snap) || typeof snap.stream !== 'string' || !Array.isArray(snap.chunks) || !Array.isArray(snap.players)) return;
      this.stream = snap.stream;
      this.attempts = 0;
      this.setStatus('open');
      this.listeners.emit({ type: 'snapshot', snapshot: snap as unknown as WorldSceneSnapshot });
      this.schedule();
    });
    es.addEventListener('world', (ev) => {
      if (!current()) return;
      const msg = parse(ev);
      if (!isObj(msg) || !(WORLD_SCENE_MESSAGES as readonly unknown[]).includes(msg.t)) return;
      this.listeners.emit({ type: 'message', msg: msg as unknown as WorldSceneMessage });
    });
    es.addEventListener('error', () => {
      if (!current()) return;
      // CONNECTING: the browser tries again on its own (and the server sends a new snapshot, with another stream id).
      // CLOSED: it gave up (429, 403, 409...): the reconnection is handled from here, with a growing wait.
      this.stream = null;
      if (es.readyState === ES_CLOSED) {
        es.close();
        this.es = null;
        this.retry();
      } else {
        this.setStatus('connecting');
      }
    });
  }

  private retry(): void {
    if (this.closed || this.retryTimer) return;
    this.setStatus('retrying');
    const delay = reconnectDelay(this.attempts++);
    this.retryTimer = this.setT(() => {
      this.retryTimer = null;
      this.setStatus('connecting');
      this.connect();
    }, delay);
  }

  /** One batch every CMD_BATCH_MS, one at a time, only with the stream open. */
  private schedule(): void {
    if (this.closed || this.flushTimer || this.inflight || !this.queue.length || !this.stream) return;
    const wait = Math.max(0, this.lastPostAt + CMD_BATCH_MS - this.now(), this.holdUntil - this.now());
    this.flushTimer = this.setT(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    const stream = this.stream;
    if (this.closed || !stream || !this.queue.length) return;
    const cmds = this.queue;
    this.queue = [];
    this.inflight = true;
    this.lastPostAt = this.now();
    let status = 0;
    let code = 'offline';
    let retryAfter = 1;
    try {
      const res = await this.fetchImpl(`${this.base}/cmd`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream, cmds }),
      });
      status = res.status;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; retryAfter?: unknown } } | null;
        if (typeof body?.error?.code === 'string') code = body.error.code;
        if (typeof body?.error?.retryAfter === 'number') retryAfter = body.error.retryAfter;
      }
    } catch {
      status = 0;
    }
    this.inflight = false;
    if (this.closed) return;
    if (status === 429 && code === 'rate_limited') {
      // Goes back to the queue (the newest move, if there is one, wins) and waits as long as the server asked.
      this.queue = enqueueCommands(cmds, this.queue);
      this.holdUntil = this.now() + retryAfter * 1000;
    } else if (status < 200 || status >= 300) {
      this.listeners.emit({ type: 'error', code });
    }
    this.schedule();
  }
}

function parse(ev: Event): unknown {
  try {
    return JSON.parse(String((ev as MessageEvent).data));
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ the fake one

/** Fake city (demo mode, screenshots and tests): the same events, with no server. Everything comes from the given clock. */
export interface FakeWorldStreamOptions {
  now?: () => number;
  /** Advances on its own (one step every 200 ms) and delivers the snapshot on the next microtask. Default: true. */
  autoplay?: boolean;
  /** How many buildings, on the spiral's first lots (default 20; `?perf=N` measures with hundreds on screen; cap 2000). */
  buildings?: number;
  /**
   * The last position, between one stream and the next on the same page (as the server keeps per account on `view.off`
   * or on a drop): whoever closes the city and comes back spawns where they were. Without it, they spawn at the door of
   * their own building.
   */
  memory?: FakeStreamMemory;
}

/** What the fake remembers between streams of the same page (`FakeWorldStreamOptions.memory`). */
export interface FakeStreamMemory {
  pos?: WorldPosition;
}

const DISTRICT = 'centro';
/** With no `move` for this long, the fake sends `afk` (like the server). */
const FAKE_AFK_MS = 60_000;
/** The server accepts the `enter` within this distance of the front of the door (2 tiles + 1 of slack). */
const FAKE_ENTER_MAX = 3;
/**
 * Statuses that the agents of the sample interior keep switching, one patch every 3 s (by the patch number, 4 at a
 * time; the 4th of each round only changes the visitors): the sample's, Beatriz answers, Thiago and Larissa go back
 * to work.
 */
const FAKE_STATUS_CYCLE: ReadonlyArray<Readonly<Record<string, WorldBuildingDetail['floors'][number]['agents'][number]['status']>>> = [
  {},
  { Beatriz: 'waiting', Larissa: 'idle', Thiago: 'shell' },
  { Beatriz: 'working', Larissa: 'idle', Thiago: 'shell' },
  { Beatriz: 'working', Larissa: 'working', Thiago: 'working' },
];

/** Me in the fake city: the character of the FakeWorldApi sample account (net/world.ts), the one in Settings. */
export const FAKE_ME: WorldSceneMe = {
  id: 'p_voce',
  name: 'Pixel Dev',
  look: 'f',
  parts: {
    skin: '#d69f78', hair: '#2b2530', hairStyle: 'bob', eyes: '#2f5f9e', top: '#4a86d8', topAccent: '#f4f4f0',
    topStyle: 'hoodie', bottom: '#2c2c35', bottomStyle: 'pants', shoes: '#ececec', accessory: 'glasses',
    accessoryColor: '#2b2b33', facialHair: 'none',
  },
  traits: ['cafeina', 'games'],
  intro: 'night_owl',
  country: 'BR',
  buildingId: 'p_voce',
};
/** My building is the 4th lot of the spiral: (3,1), with the door on the south sidewalk of block (1,0). */
const MY_LOT_INDEX = 3;
/** The code of my building in the fake city (the same as the FakeWorldApi's). */
export const FAKE_MY_CODE = 'HB-4F2K';
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Fictitious, stable code of each lot of the fake city ("HB-" + 4 from the alphabet without the confusing ones). */
export function fakeBuildingCode(i: number): string {
  let v = (Math.imul(i + 7, 2654435761) >>> 0) % CODE_ALPHABET.length ** 4;
  let out = '';
  for (let k = 0; k < 4; k++) {
    out = CODE_ALPHABET[v % CODE_ALPHABET.length] + out;
    v = Math.floor(v / CODE_ALPHABET.length);
  }
  const code = `HB-${out}`;
  return code === FAKE_MY_CODE ? 'HB-7777' : code;
}

/** The code as someone typed it, in the canonical format (or null), as the world server does. */
function normalizeCode(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[\s_]+/g, '');
  const body = s.startsWith('HB-') ? s.slice(3) : s.startsWith('HB') && s.length === 6 ? s.slice(2) : s;
  return /^[2-9A-HJKMNP-TV-Z]{4}$/.test(body) ? `HB-${body}` : null;
}

/** A reply that matches the greeting (the bots answer). */
const REPLY: Readonly<Record<GreetingId, GreetingId>> = {
  hello: 'nice_to_meet', wave: 'hello', nice_building: 'thanks', congrats: 'thanks', clap: 'thanks', good_luck: 'thanks',
  coffee: 'coffee', bye: 'bye', thanks: 'clap', nice_to_meet: 'wave',
};

/** Fictitious owners (made-up player names). */
const OWNERS: ReadonlyArray<readonly [string, string | undefined]> = [
  ['Ana Pixel', 'BR'], ['Bruno Byte', 'PT'], ['Camille Code', 'FR'], ['Diego Deploy', 'MX'], ['Emma Stack', 'US'],
  ['Felipe Fork', 'AR'], ['Gabi Git', 'BR'], ['Hiro Hash', 'JP'], ['Inês Infra', 'ES'], ['Jonas Json', 'DE'],
  ['Kai Kernel', 'CA'], ['Lia Lambda', 'IT'], ['Marco Merge', 'CL'], ['Nina Node', 'CO'], ['Oscar Ops', 'GB'],
  ['Priya Patch', 'IN'], ['Quim Query', undefined], ['Rosa Regex', 'BR'], ['Sami Shell', 'KR'], ['Téo Test', 'PT'],
];
const FLOORS = [2, 6, 13, 4, 9, 3, 16, 5, 0, 11, 4, 7, 2, 20, 8, 3, 12, 1, 6, 10] as const;
const THEMES: readonly WorldTheme[] = ['none', 'halloween', 'none', 'christmas', 'none', 'halloween'];
const TRAITS: readonly (readonly TraitId[])[] = [['games', 'piadas'], ['leitura', 'calma'], ['competicao', 'esporte', 'cafeina'], ['series', 'fofoca'], ['esporte', 'cafeina'], ['timidez', 'leitura']];
const INTROS: readonly IntroId[] = ['coffee', 'tabs', 'pixel_art', 'cats', 'ship_fast', 'music'];

/**
 * The 5 who walk (the block they go around, the direction, the speed in tiles/s and where they start) and which
 * building each one owns (index in the spiral; the player's id is the building's). The 6th sits on a bench in the plaza.
 */
const WALKERS: ReadonlyArray<{ name: string; look: 'f' | 'm'; block: CityPoint; cw: boolean; speed: number; phase: number; owns?: number }> = [
  { name: 'Luna Loop', look: 'f', block: { x: 1, y: 0 }, cw: true, speed: 3.0, phase: 12, owns: 1 },
  { name: 'Max Merge', look: 'm', block: { x: 1, y: 0 }, cw: false, speed: 3.2, phase: 70 },
  { name: 'Zoe Zip', look: 'f', block: { x: 0, y: 0 }, cw: true, speed: 2.9, phase: 40, owns: 7 },
  { name: 'Rafa Runtime', look: 'm', block: { x: 1, y: 1 }, cw: false, speed: 3.1, phase: 110 },
  { name: 'Yuki Yarn', look: 'f', block: { x: 0, y: 1 }, cw: true, speed: 5.6, phase: 25, owns: 13 },
];
const SITTER = { name: 'Ravi Repo', look: 'm' as const };
/** Each one's country (the 4th does not show it). */
const COUNTRY_OF_WALKER: readonly string[] = ['BR', 'US', 'FR', 'ES', 'JP', 'IN'];

/** The middle of the sidewalk around a block (2 tiles wide: the middle is the joint between the two). */
function sidewalkLoop(block: CityPoint): { x0: number; y0: number; x1: number; y1: number; length: number } {
  const o = blockOrigin(block);
  const x0 = o.x - 1;
  const y0 = o.y - 1;
  const x1 = o.x + BLOCK_TILES.w + 1;
  const y1 = o.y + BLOCK_TILES.h + 1;
  return { x0, y0, x1, y1, length: 2 * (x1 - x0 + (y1 - y0)) };
}

/** Where someone who walks `dist` tiles along the loop is (clockwise: east, south, west, north). */
export function loopPosition(block: CityPoint, dist: number, cw: boolean): WorldPosition {
  const l = sidewalkLoop(block);
  const w = l.x1 - l.x0;
  const h = l.y1 - l.y0;
  let d = ((cw ? dist : -dist) % l.length + l.length) % l.length;
  const round = (v: number) => Math.round(v * 100) / 100;
  const at = (x: number, y: number, dirCw: Direction, dirCcw: Direction): WorldPosition => ({ x: round(x), y: round(y), dir: cw ? dirCw : dirCcw, moving: true });
  if (d < w) return at(l.x0 + d, l.y0, 'e', 'w');
  d -= w;
  if (d < h) return at(l.x1, l.y0 + d, 's', 'n');
  d -= h;
  if (d < w) return at(l.x1 - d, l.y1, 'w', 'e');
  d -= w;
  return at(l.x0, l.y1 - d, 'n', 's');
}

/** The seat of the bench south of the fountain, on the right (tiles): where the 6th player sits. */
export function fakeBenchSeat(): CityPoint {
  const o = blockOrigin(PLAZA);
  return { x: o.x + FOUNTAIN.x + FOUNTAIN.w / 2 + 5, y: o.y + FOUNTAIN.y + FOUNTAIN.h + 2 + 0.85 };
}

/** Where I spawn: on the sidewalk in front of my building's door (as the server does with whoever has a building). */
export function fakeMyDoor(): CityPoint {
  return lotDoor(fakeLots(MY_LOT_INDEX + 1)[MY_LOT_INDEX]!).front;
}

const chunkOfPos = (x: number, y: number) => chunkId(DISTRICT, chunkOf(blockAt(x, y)));

/** The fake city's goal of the week: the first one (10,000 agent hours), at 80 %, until next Monday (UTC). */
export function fakeGoal(now: number): CityGoal {
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000;
  return { id: `${new Date(monday).toISOString().slice(0, 10)}:agent_hours_10k`, label: 'agent_hours_10k', target: 10_000, progress: 8_000, until: monday + 7 * 86_400_000 };
}

function fakeLots(n: number): CityPoint[] {
  const lots: CityPoint[] = [];
  for (const lot of lotSpiral()) {
    if (lots.length >= n) break;
    lots.push(lot);
  }
  return lots;
}

/** The fake city's buildings, on the first `n` lots of the spiral (mine on the 4th); all fictitious and deterministic. */
export function fakeCityBuildings(n = 20): WorldBuildingPublic[] {
  const rng = mulberry32(0xc17c17);
  const count = Math.max(1, Math.min(2000, Math.floor(n)));
  const owners = new Map<number, number>();
  WALKERS.forEach((w, k) => w.owns !== undefined && owners.set(w.owns, k));
  return fakeLots(count).map((lot, i) => {
    const mine = i === MY_LOT_INDEX;
    const [name, country] = OWNERS[i % OWNERS.length]!;
    const walker = owners.get(i);
    const floors = mine ? 4 : FLOORS[i % FLOORS.length]!;
    const total = Math.max(1, Math.round(floors * (1 + rng() * 1.5)));
    const working = Math.round(total * rng());
    const waiting = Math.min(total - working, rng() < 0.4 ? 1 + Math.floor(rng() * 2) : 0);
    const away = !mine && (i % 7 === 5 || i % 11 === 9);
    const discreet = !mine && i % 9 === 7;
    const id = mine ? FAKE_ME.id : walker !== undefined ? `p_${walker + 1}` : `b_${i.toString(36).padStart(3, '0')}`;
    const owner = mine
      ? { id, name: FAKE_ME.name, country: FAKE_ME.country }
      : walker !== undefined
        ? { id, name: WALKERS[walker]!.name, country: COUNTRY_OF_WALKER[walker] }
        : { id, name: count > OWNERS.length ? `${name} ${Math.floor(i / OWNERS.length) + 1}` : name, ...(country ? { country } : {}) };
    const b: WorldBuildingPublic = {
      id,
      lot: { district: DISTRICT, x: lot.x, y: lot.y },
      owner,
      state: away ? 'away' : 'online',
      theme: mine ? 'halloween' : THEMES[i % THEMES.length]!,
      floors,
      rev: 1,
      likes: Math.floor(rng() * 240),
      sinceMonth: `2026-${String(8 + (i % 3)).padStart(2, '0')}`,
    };
    if (!discreet) b.agents = { total, working, waiting, idle: total - working - waiting };
    if (i % 4 !== 1) b.tokens = { day: (i % 5) as TokenBand, week: Math.min(5, (i % 5) + 1) as TokenBand };
    if (i % 8 === 6) b.closed = true;
    // Phase 5: the building's code, who accepts knocks on the door and an "unverified" building (Phase 6)
    b.code = mine ? FAKE_MY_CODE : fakeBuildingCode(i);
    if (i % 3 === 1 || i === 4) b.knocks = true;
    if (i === 10) (b as WorldBuildingPublic & { unverified?: true }).unverified = true;
    return b;
  });
}

export class FakeWorldStream implements WorldStream {
  private readonly listeners = new Listeners();
  private readonly now: () => number;
  private readonly start: number;
  private readonly buildings: WorldBuildingPublic[];
  private readonly revs = new Map<string, number>();
  private readonly walkers: WorldPlayerPublic[];
  private me: WorldPosition;
  private viewing = true;
  private closed = false;
  private ticks = 0;
  private lastMoveAt: number;
  private afkSent = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Answers to the commands: they go out on the next step, like a round trip. */
  private pending: WorldSceneMessage[] = [];
  /** Inside a building (visit): the interior and its `rev`. */
  private inside: { id: string; rev: number; detail: WorldBuildingDetail; patches: number } | null = null;
  /** Messages for later (the bots' replies to the greetings). */
  private later: Array<{ at: number; msg: WorldSceneMessage }> = [];
  /** Random picks of the social features (deterministic, like the rest of the fake city). */
  private readonly social = mulberry32(0x50c1a1);
  private readonly memory?: FakeStreamMemory;
  /** The owner saw the "While you were away" (`summary.seen`): the snapshot no longer brings it. */
  private summarySeen = false;
  /** Who I blocked (disappears from the street). */
  private readonly hidden = new Set<string>();
  /** Today's stamps (one per building). */
  private readonly stamped = new Set<string>();
  /** When each bot last greeted me. */
  private readonly greetedMe = new Map<string, number>();
  /** The goal of the week (agent hours): starts at 80 % of the first one. */
  private goal: CityGoal;

  constructor(o: FakeWorldStreamOptions = {}) {
    this.now = o.now ?? Date.now;
    this.start = this.now();
    this.lastMoveAt = this.start;
    this.buildings = fakeCityBuildings(o.buildings ?? 20);
    for (const b of this.buildings) this.revs.set(this.chunkOfBuilding(b), 1);
    const mine = this.buildings.find((b) => b.id === FAKE_ME.id);
    const door = mine ? lotDoor(mine.lot).front : spawnPoint();
    this.memory = o.memory;
    // back in the city: spawns where they were (the last position kept on `view.off` or on closing)
    const last = o.memory?.pos;
    this.me = last ? { x: last.x, y: last.y, dir: last.dir, moving: false } : { x: door.x, y: door.y, dir: 's', moving: false };
    this.goal = fakeGoal(this.start);
    const prng = mulberry32(0x9e1a);
    const player = (k: number, name: string, look: 'f' | 'm', pos: WorldPosition): WorldPlayerPublic => {
      const owns = WALKERS[k]?.owns;
      const id = `p_${k + 1}`;
      return {
        id,
        name,
        ...(k === 3 ? {} : { country: COUNTRY_OF_WALKER[k]! }),
        look,
        parts: flattenAppearance(1_000 + k * 97, undefined, look),
        traits: [...TRAITS[k % TRAITS.length]!],
        intro: INTROS[k % INTROS.length]!,
        ...(owns !== undefined && owns < this.buildings.length ? { buildingId: id } : {}),
        likesReceived: Math.floor(prng() * 60),
        pos,
        where: 'street',
      };
    };
    this.walkers = WALKERS.map((w, k) => player(k, w.name, w.look, loopPosition(w.block, w.phase, w.cw)));
    // sitting on the bench south of the fountain: standing still on top of a bench, the scene draws them sitting
    const seat = fakeBenchSeat();
    this.walkers.push(player(WALKERS.length, SITTER.name, SITTER.look, { x: seat.x, y: seat.y, dir: 's', moving: false }));
    if (o.autoplay !== false) {
      this.timer = setInterval(() => this.tick(), CMD_BATCH_MS);
    }
  }

  on(listener: (ev: WorldStreamEvent) => void): () => void {
    const off = this.listeners.add(listener);
    // Like the real one: the snapshot arrives after opening (never inside the `on`).
    void Promise.resolve().then(() => {
      if (this.closed) return;
      listener({ type: 'status', status: 'open' });
      listener({ type: 'snapshot', snapshot: this.snapshot() });
    });
    return off;
  }

  /** The whole state, like the local server's `world.snapshot`. */
  snapshot(): WorldSceneSnapshot {
    const byChunk = new Map<string, WorldBuildingPublic[]>();
    for (const b of this.buildings) {
      const c = this.chunkOfBuilding(b);
      if (!byChunk.has(c)) byChunk.set(c, []);
      byChunk.get(c)!.push(b);
    }
    return structuredClone({
      stream: 'fake',
      connected: true,
      viewing: this.viewing,
      district: DISTRICT,
      me: FAKE_ME,
      pos: this.me,
      afk: this.afkSent,
      chunks: this.viewing ? [...byChunk.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([chunk, buildings]) => ({ chunk, rev: this.revs.get(chunk) ?? 1, buildings })) : [],
      players: this.viewing && !this.inside ? this.walkers.filter((p) => !this.hidden.has(p.id)) : [],
      minimap: this.viewing ? this.minimap() : null,
      ...(this.inside ? { inside: { id: this.inside.id, rev: this.inside.rev, detail: this.inside.detail } } : {}),
      ...(this.viewing ? { city: this.cityStatus() } : {}),
      likesToday: 3,
      // the "While you were away" that the server sends the owner on connecting (the same as the FakeWorldApi's)
      ...(this.summarySeen ? {} : { summary: structuredClone(FAKE_SUMMARY) }),
    });
  }

  /** The city (↓ `city`): the lit buildings, the goal of the week and the token range. */
  private cityStatus(): { lit: number; goal: CityGoal; tokensBand: TokenBand } {
    return { lit: this.buildings.filter((b) => b.state === 'online').length, goal: { ...this.goal }, tokensBand: 4 };
  }

  /** The city hit the goal (the test button of `?fireworks=1`): fireworks and the next goal. */
  celebrate(): void {
    if (this.closed) return;
    const reached = this.goal;
    this.emit({ t: 'city.fireworks', goalId: reached.id });
    const next = reached.label === 'agent_hours_10k' ? 'agent_hours_50k' : 'agent_hours_100k';
    const target = next === 'agent_hours_50k' ? 50_000 : 100_000;
    this.goal = { id: reached.id.replace(reached.label, next), label: next, target, progress: Math.max(reached.target, reached.progress), until: reached.until };
    this.emit({ t: 'city', ...this.cityStatus() });
  }

  send(cmds: WorldSceneCommand[]): void {
    if (this.closed) return;
    for (const c of reduceSceneBatch(cmds)) this.command(c);
  }

  close(): void {
    if (this.closed) return;
    this.remember();
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.emit({ type: 'status', status: 'closed' });
    this.listeners.clear();
  }

  /** Keeps the last position (standing still) for the next `view`, on this stream or on the next one of the same page. */
  private remember(): void {
    if (this.memory) this.memory.pos = { x: this.me.x, y: this.me.y, dir: this.me.dir, moving: false };
  }

  /** One step (200 ms): the pending answers, the 5 walking, every 3 s a building that changes and the `afk`. */
  tick(): void {
    if (this.closed) return;
    this.ticks++;
    const out = this.pending;
    this.pending = [];
    for (const m of out) this.emit(m);
    if (!this.viewing) return;
    // inside a building, nothing from the street comes down: only the interior changing every 3 s
    if (this.inside) {
      if (this.ticks % 15 === 0) this.patchInside();
      return;
    }
    const now = this.now();
    const due = this.later.filter((l) => l.at <= now);
    if (due.length) {
      this.later = this.later.filter((l) => l.at > now);
      for (const l of due) this.emit(l.msg);
    }
    const t = (now - this.start) / 1000;
    const byChunk = new Map<string, Array<{ id: string; pos: WorldPosition }>>();
    WALKERS.forEach((w, i) => {
      const p = this.walkers[i]!;
      p.pos = loopPosition(w.block, w.phase + w.speed * t, w.cw);
      if (this.hidden.has(p.id)) return;
      const c = chunkOfPos(p.pos.x, p.pos.y);
      if (!byChunk.has(c)) byChunk.set(c, []);
      byChunk.get(c)!.push({ id: p.id, pos: { ...p.pos } });
    });
    for (const [chunk, players] of byChunk) this.emit({ t: 'players', chunk, players });
    if (this.ticks % 15 === 0) this.changeBuilding(this.ticks / 15);
    if (this.ticks % 300 === 0) this.emit({ t: 'minimap', blocks: this.minimap() });
    if (this.ticks % 300 === 0) {
      // the goal moves a little every minute (agents working across the whole city)
      this.goal = { ...this.goal, progress: Math.min(this.goal.target - 1, this.goal.progress + 7) };
      this.emit({ t: 'city', ...this.cityStatus() });
    }
    if (this.ticks % 25 === 0) this.botsGreet(now);
    if (!this.afkSent && now - this.lastMoveAt >= FAKE_AFK_MS) {
      this.afkSent = true;
      this.emit({ t: 'afk' });
    }
  }

  /**
   * The bots greet each other (two who see each other, and the other answers in 1.6 s) and, sometimes, greet whoever is
   * near them (me), at most once every 30 s each.
   */
  private botsGreet(now: number): void {
    const bots = this.walkers.filter((p) => !this.hidden.has(p.id));
    if (bots.length >= 2) {
      const a = bots[Math.floor(this.social() * bots.length)]!;
      const others = bots.filter((p) => p !== a).sort((x, y) => Math.hypot(x.pos.x - a.pos.x, x.pos.y - a.pos.y) - Math.hypot(y.pos.x - a.pos.x, y.pos.y - a.pos.y));
      const b = others[0]!;
      const g = GREETING_IDS[Math.floor(this.social() * GREETING_IDS.length)]!;
      this.emit({ t: 'greeting', from: a.id, to: b.id, greetingId: g, until: now + 5_000 });
      this.later.push({ at: now + 1_600, msg: { t: 'greeting', from: b.id, to: a.id, greetingId: REPLY[g], until: now + 6_600 } });
    }
    for (const p of bots) {
      if (Math.hypot(p.pos.x - this.me.x, p.pos.y - this.me.y) > 7 || now - (this.greetedMe.get(p.id) ?? -Infinity) < 30_000) continue;
      if (this.social() < 0.5) continue;
      this.greetedMe.set(p.id, now);
      const g: GreetingId = this.social() < 0.5 ? 'hello' : 'wave';
      this.emit({ t: 'greeting', from: p.id, to: FAKE_ME.id, greetingId: g, until: now + 5_000 });
      break;
    }
  }

  /** Agents start or stop working and likes arrive at a building (area.patch with the `rev` + 1). */
  private changeBuilding(n: number): void {
    const b = this.buildings[(n * 7) % this.buildings.length]!;
    if (!b.agents || b.state !== 'online') return;
    // every now and then they all stop at once (end of turn: confetti on the facade)
    const working = n % 4 === 0 && b.agents.working > 0 ? 0 : (b.agents.working + 1) % (b.agents.total + 1);
    const waiting = Math.min(b.agents.total - working, n % 2);
    b.agents = { total: b.agents.total, working, waiting, idle: b.agents.total - working - waiting };
    if (n % 3 === 0) b.likes++;
    b.rev++;
    const chunk = this.chunkOfBuilding(b);
    const rev = (this.revs.get(chunk) ?? 1) + 1;
    this.revs.set(chunk, rev);
    this.emit({ t: 'area.patch', chunk, rev, changes: [{ id: b.id, agents: { ...b.agents }, likes: b.likes, rev: b.rev }] });
  }

  private command(c: WorldSceneCommand): void {
    switch (c.t) {
      case 'move': {
        // Like the server: walkable destination and near the last one (a 200 ms step running is ~1.2 tile).
        const far = Math.hypot(c.x - this.me.x, c.y - this.me.y) > 6;
        if (!isWalkable(c.x, c.y, () => true) || far) {
          this.pending.push({ t: 'pos', x: this.me.x, y: this.me.y });
          return;
        }
        const changed = c.x !== this.me.x || c.y !== this.me.y || c.dir !== this.me.dir || c.moving !== this.me.moving;
        this.me = { x: c.x, y: c.y, dir: c.dir, moving: c.moving };
        if (changed) {
          this.lastMoveAt = this.now();
          this.afkSent = false;
        }
        return;
      }
      case 'profile': {
        const p = this.walkers.find((w) => w.id === c.playerId);
        this.pending.push(p ? { t: 'profile', player: structuredClone(p) } : { t: 'notice', level: 'info', text: 'not_found' });
        return;
      }
      case 'like':
      case 'unlike': {
        // like the server: within 4 steps of the door, never on your own building
        const b = this.near(c.buildingId, 4);
        if (typeof b === 'string') return void this.pending.push({ t: 'notice', level: 'warn', text: b });
        const liked = c.t === 'like';
        if (!!b.likedByMe !== liked) b.likes += liked ? 1 : -1;
        b.likedByMe = liked;
        this.pending.push({ t: 'like.update', buildingId: b.id, likes: b.likes, likedByMe: liked });
        // from inside: the interior too (like the `building` of the server's next `building.patch`)
        if (this.inside?.id === b.id) Object.assign(this.inside.detail.building, { likes: b.likes, likedByMe: liked });
        return;
      }
      case 'greet': {
        const to = this.walkers.find((p) => p.id === c.playerId && !this.hidden.has(p.id));
        if (!to) return void this.pending.push({ t: 'notice', level: 'info', text: 'not_found' });
        const now = this.now();
        this.pending.push({ t: 'greeting', from: FAKE_ME.id, to: c.playerId, greetingId: c.greetingId as GreetingId, until: now + 5_000 });
        // the bot answers
        this.later.push({ at: now + 1_200, msg: { t: 'greeting', from: c.playerId, to: FAKE_ME.id, greetingId: REPLY[c.greetingId as GreetingId] ?? 'wave', until: now + 6_200 } });
        return;
      }
      case 'stamp': {
        const b = this.near(c.buildingId, 2);
        if (typeof b === 'string') return void this.pending.push({ t: 'notice', level: 'warn', text: b });
        if (this.stamped.has(b.id)) return void this.pending.push({ t: 'notice', level: 'info', text: 'already_done' });
        this.stamped.add(b.id);
        this.pending.push({ t: 'notice', level: 'info', text: 'stamped' });
        return;
      }
      case 'knock': {
        // whoever knocks never knows if the owner is there: no answer, only the refusal from far away
        const b = this.near(c.buildingId, 2);
        if (typeof b === 'string') this.pending.push({ t: 'notice', level: 'warn', text: b });
        return;
      }
      case 'teleport': {
        const code = c.code === undefined ? null : normalizeCode(c.code);
        let target: WorldBuildingPublic | undefined;
        if (c.code !== undefined) target = code ? this.buildings.find((b) => b.code === code && !this.hidden.has(b.id)) : undefined;
        else {
          const lit = this.buildings.filter((b) => b.state === 'online' && b.id !== FAKE_ME.id && !this.hidden.has(b.id));
          target = lit[Math.floor(this.social() * lit.length)];
        }
        if (!target) return void this.pending.push({ t: 'notice', level: 'info', text: 'not_found' });
        const d = lotDoor(target.lot);
        this.me = { x: d.front.x, y: d.front.y, dir: d.side, moving: false };
        this.lastMoveAt = this.now();
        this.afkSent = false;
        this.pending.push({ t: 'pos', x: d.front.x, y: d.front.y });
        // the area around the new place (the scene only keeps the 3×3 chunks around me)
        for (const ch of this.snapshot().chunks) this.pending.push({ t: 'area', chunk: ch.chunk, rev: ch.rev, buildings: ch.buildings });
        return;
      }
      case 'block': {
        const p = this.walkers.find((x) => x.id === c.playerId);
        if (!p) return void this.pending.push({ t: 'notice', level: 'info', text: 'not_found' });
        this.hidden.add(p.id);
        this.pending.push({ t: 'player.leave', id: p.id }, { t: 'notice', level: 'info', text: 'blocked_ok' });
        return;
      }
      case 'unblock': {
        const p = this.walkers.find((x) => x.id === c.playerId);
        if (!p || !this.hidden.delete(p.id)) return;
        this.pending.push({ t: 'player.join', player: structuredClone(p) });
        return;
      }
      case 'resync':
        for (const ch of this.snapshot().chunks) {
          if (c.chunk === undefined || ch.chunk === c.chunk) this.pending.push({ t: 'area', chunk: ch.chunk, rev: ch.rev, buildings: ch.buildings });
        }
        return;
      case 'view':
        this.viewing = true;
        void Promise.resolve().then(() => !this.closed && this.listeners.emit({ type: 'snapshot', snapshot: this.snapshot() }));
        return;
      case 'view.off':
        this.remember();
        this.viewing = false;
        this.inside = null;
        return;
      case 'enter':
        this.enter(c.buildingId);
        return;
      case 'leave': {
        const b = this.inside ? this.buildings.find((x) => x.id === this.inside!.id) : undefined;
        this.inside = null;
        if (b) {
          const d = lotDoor(b.lot);
          this.me = { x: d.front.x, y: d.front.y, dir: d.side === 's' ? 's' : 'n', moving: false };
        }
        this.lastMoveAt = this.now();
        this.pending.push({ t: 'pos', x: this.me.x, y: this.me.y });
        for (const ch of this.snapshot().chunks) this.pending.push({ t: 'area', chunk: ch.chunk, rev: ch.rev, buildings: ch.buildings });
        return;
      }
      default:
        // report: the `reported`; summary.seen: nothing comes back (and the summary leaves the snapshot).
        if (c.t === 'report') this.pending.push({ t: 'notice', level: 'info', text: 'reported' });
        if (c.t === 'summary.seen') this.summarySeen = true;
        return;
    }
  }

  /** `enter`: like the server (does not exist, far away, closed), and the sample interior depending on the building. */
  private enter(id: string): void {
    const b = this.buildings.find((x) => x.id === id);
    if (!b) {
      this.pending.push({ t: 'notice', level: 'info', text: 'not_found' });
      return;
    }
    const mine = b.id === FAKE_ME.id;
    const d = lotDoor(b.lot).front;
    if (!mine && Math.hypot(this.me.x - d.x, this.me.y - d.y) > FAKE_ENTER_MAX) {
      this.pending.push({ t: 'notice', level: 'info', text: 'too_far' });
      return;
    }
    if (!mine && b.closed) {
      this.pending.push({ t: 'notice', level: 'info', text: 'closed' });
      return;
    }
    const mode = b.state === 'away' ? 'away' : b.agents ? 'live' : 'discreet';
    const detail = sampleBuildingDetail(mode);
    const { agents: _agents, ...pub } = b;
    detail.building = { ...pub, ...(detail.building.agents ? { agents: detail.building.agents } : {}), floors: detail.floors.length, ...(mode === 'discreet' ? { discreet: true } : {}) };
    detail.visitors = mine ? 0 : 2; // the owner viewing their own building does not count
    this.inside = { id: b.id, rev: 1, detail, patches: 0 };
    this.pending.push({ t: 'building', rev: 1, detail: structuredClone(detail) });
  }

  /** The interior changes: agents change status (live) and, every now and then, someone comes in or leaves. */
  private patchInside(): void {
    const ins = this.inside;
    if (!ins) return;
    ins.patches++;
    if (ins.patches % 4 === 0) {
      ins.detail.visitors = ins.detail.visitors >= 3 ? 2 : ins.detail.visitors + 1;
      ins.rev++;
      this.emit({ t: 'building.patch', rev: ins.rev, visitors: ins.detail.visitors });
      return;
    }
    if (ins.detail.building.state !== 'online' || ins.detail.building.discreet) return;
    const next = FAKE_STATUS_CYCLE[ins.patches % FAKE_STATUS_CYCLE.length]!;
    for (const f of ins.detail.floors) for (const a of f.agents) if (next[a.name]) a.status = next[a.name]!;
    ins.rev++;
    this.emit({ t: 'building.patch', rev: ins.rev, floors: structuredClone(ins.detail.floors) });
  }

  /**
   * The building within `max` steps of the door (as the server checks) or the building I am in (from inside it counts
   * without the distance), or the notice: far away, mine or none.
   */
  private near(id: string, max: number): WorldBuildingPublic | 'too_far' | 'invalid' | 'not_found' {
    if (id === FAKE_ME.id) return 'invalid';
    const b = this.buildings.find((x) => x.id === id);
    if (!b) return 'not_found';
    if (this.inside?.id === id) return b;
    const f = lotDoor(b.lot).front;
    return Math.hypot(f.x - this.me.x, f.y - this.me.y) <= max + 1e-9 ? b : 'too_far';
  }

  private emit(msg: WorldSceneMessage): void {
    this.listeners.emit({ type: 'message', msg: structuredClone(msg) });
  }

  private chunkOfBuilding(b: WorldBuildingPublic): string {
    return chunkId(DISTRICT, chunkOf(blockOf(b.lot)));
  }

  private minimap(): Array<{ x: number; y: number; lit: number }> {
    const blocks = new Map<string, { x: number; y: number; lit: number }>();
    for (const b of this.buildings) {
      const bl = blockOf(b.lot);
      const key = `${bl.x},${bl.y}`;
      if (!blocks.has(key)) blocks.set(key, { x: bl.x, y: bl.y, lit: 0 });
      if (b.state === 'online') blocks.get(key)!.lit++;
    }
    return [...blocks.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  }
}

// ------------------------------------------------------------------------------------------------ factory

/** The scene's stream: in demo mode, the fake city; outside it, the local server. */
export function createWorldStream(opts: { mock: boolean } & HttpWorldStreamOptions & FakeWorldStreamOptions): WorldStream {
  return opts.mock ? new FakeWorldStream(opts) : new HttpWorldStream(opts);
}
