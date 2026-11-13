// Office simulation: reconciles server snapshots with the world's characters and rooms,
// plans behaviors and runs the step queues every frame.
import { partsKey } from '../../../../shared/appearance';
import type { AgentInfo, OfficeSnapshot, Provider, RoomInfo } from '../../../../shared/types';
import type { ArtModule, Dir, RoomTheme } from '../../art/api';
import type { WorldOptions } from '../api';
import { COL_W, COMPACT_DELAY_MS, DISMANTLE_DELAY_MS, FOOT_DX, FOOT_DY, MISSING_DEBOUNCE_MS, RUN_SPEED, TILE, WALK_SPEED } from '../constants';
import { assembleBuilding, type BuildingLayout } from '../layout/building';
import { RECEPTION_ID } from '../layout/core';
import { columnsFor, inRect } from '../layout/geometry';
import { layoutProjectRoom } from '../layout/room';
import type { SpotDef, SpotKind } from '../layout/types';
import { PathFinder } from '../path/astar';
import { BLOCKED, FREE, SEAT } from '../path/grid';
import { PROGRAM_SEED } from '../social/gathering';
import { hasTrait, personaFor, soloWeights } from '../social/persona';
import { Social } from '../social/social';
import { browserStorage, type StorageLike } from '../social/wallet';
import {
  canDismantle,
  chooseSeat,
  idleSitMs,
  isLastInRoom,
  isLongIdle,
  modeFor,
  pickIdleActivity,
  shouldRun,
  type IdleActivity,
  type Mode,
} from './behavior';
import { Character, dirOf, facing } from './character';
import { Elevator } from './elevator';
import { RoomFxState } from './github';
import { RoomState } from './room-state';
import { countShells, latestShellDone, shellLabel, shellStage, shellWaitSince, spinDir, spinPhase, yawnPhase } from './shell';
import { SpotRegistry } from './spots';
import type { Step } from './steps';
import { EXIT_RADIUS, NO_INTENT, stepFree, tileAt, VISITOR_LANYARD, type VisitorIntent } from './visitor';
import { tr } from '../../../../shared/i18n';

/**
 * One-off visual effect the simulation asks the render for (drained every frame): confetti (shell
 * finished), coins flying from whoever lost the bet to whoever won, and sparkle (mirror).
 */
export type WorldEffect =
  | { kind: 'confetti'; charId: string; at: number }
  | { kind: 'coins'; charId: string; toId: string; at: number }
  | { kind: 'sparkle'; charId: string; at: number };

export { SHELL_DONE_TOOL } from './shell';

/** How the `Sim` runs (fixed at creation). */
export interface SimMode {
  /**
   * Visit to a building of the world (Visit scene): no time comes down from the world (the `statusSince` are "now",
   * at entry), so nothing that depends on how long ago (popcorn, spins, cobweb, yawns and nap of whoever waits for a
   * shell, nap of whoever has been idle for a long time, speech bubble timer); plus the visitor and the visit's lights.
   */
  visit?: boolean;
}

/** Visit lights: 'away' (paused) turns everything off; 'discreet' lights the empty rooms; 'live' is the usual `Sim`. */
export type VisitLight = 'live' | 'discreet' | 'away';
/** Celebration (shell finished) and lament (failed/killed). */
const CHEER_MS = 2_200;
const SULK_MS = 4_000;
const MAX_EFFECTS = 32;
/** Owner of the place reservations of a ghost room (old address of a move). */
const GHOST_OWNER = '@mudança';

const FALLBACK_THEME: RoomTheme = {
  carpet: '#5b7fa6',
  carpet2: '#4f7093',
  wall: { base: '#e7e3db', trim: '#9b9184', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

const LOUNGE_SEATS: SpotKind[] = ['sofa', 'armchair', 'beanbag'];
/** Where one can sit and use the phone. */
const PHONE_SEATS: SpotKind[] = ['beanbag', 'sofa', 'armchair', 'cafe_seat', 'bench'];
/** Rest seats possible already at the initial load (not hallway/bathroom benches). */
const INITIAL_LOUNGE_SEATS: SpotKind[] = ['sofa', 'armchair', 'beanbag', 'cafe_seat'];
/** Fraction of the eligible idle ones that starts away from the desk. */
const INITIAL_LOUNGE_SHARE = 0.15;
/** Only whoever has been idle for at least this long can start out resting (whoever just stopped comes back soon). */
const INITIAL_LOUNGE_MIN_IDLE_MS = 90_000;
/** Nobody goes on an outing in the first seconds after the page opens. */
const INITIAL_OUTING_DELAY_MS = 5_000;
const ENTER_MS = 180;

function between(rng: () => number, a: number, b: number): number {
  return a + rng() * (b - a);
}

/** What defines a character's appearance (changes when the character is edited). */
const lookSig = (a: AgentInfo): string => `${a.seed}|${a.look}|${partsKey(a.parts)}`;

export class Sim {
  readonly chars = new Map<string, Character>();
  readonly rooms = new Map<string, RoomState>();
  readonly spots = new SpotRegistry();
  readonly elevators: Elevator[] = [];
  building: BuildingLayout;
  readonly finder: PathFinder;
  /** Increments when the building changes (rooms appear/disappear, width). */
  layoutVersion = 0;
  now = 0;
  initialized = false;
  /** furnitureId -> until when the machine is in use (coffee maker brewing coffee). */
  readonly machineUntil = new Map<string, number>();
  /** Occupied stalls (furnitureId). */
  readonly stallBusy = new Set<string>();
  /** Social life: hangouts of the idle, personalities and wallets (social/social.ts). */
  readonly social: Social;
  /** Debugging: agents forced to end and rooms forced to disappear from the snapshot. */
  readonly forcedOffline = new Set<string>();
  readonly hiddenRooms = new Set<string>();
  /** Snapshot accounts (id -> color/letter/tool) for labels: the Codex one gets a hollow chip and the badge. */
  accounts = new Map<string, { short: string; color: string; name: string; provider?: Provider }>();
  /** Debugging: extra rooms/agents merged into every snapshot (simulated sessions). */
  injected: { rooms: RoomInfo[]; agents: AgentInfo[] } = { rooms: [], agents: [] };
  /** Debugging: fields overlaid on real agents of the snapshot (e.g. forced shells). */
  readonly agentPatches = new Map<string, Partial<AgentInfo>>();
  /** One-off effects (confetti) for the render to draw; the render empties the list. */
  readonly effects: WorldEffect[] = [];
  /** Party and alarm of the rooms (GitHub events; sim/github.ts). */
  readonly roomFx = new RoomFxState();
  private lastSnapshot: OfficeSnapshot | null = null;
  /** Since when there has been a free slot before the last room (0 = there is none). */
  private gapSince = 0;
  private moveSeq = 0;
  private shrinkPending = false;
  private nextHousekeeping = 0;
  /** Visit to a building of the world (SimMode.visit). */
  readonly visit: boolean;
  /** Visit: my character (outside `chars`: no snapshot, no social life, no reserved place). */
  visitor: Character | null = null;
  /** Visit: where the keyboard sends the visitor. */
  visitorIntent: VisitorIntent = { ...NO_INTENT };
  /** Visit: the building's lights (applied on every snapshot and every second). */
  visitLight: VisitLight = 'live';

  /** `storage` of the wallets: null = in memory only (the timelapse doesn't touch the real coins). */
  constructor(
    private readonly art: ArtModule,
    private readonly options: () => WorldOptions,
    storage: StorageLike | null = browserStorage(),
    mode: SimMode = {},
  ) {
    this.visit = !!mode.visit;
    this.social = new Social(this, storage);
    this.building = assembleBuilding(columnsFor([]), [], 0);
    this.finder = new PathFinder(this.building.grid);
    this.spots.setSpots(this.building.spots);
    for (const s of this.spots.ofKind('elevator')) this.elevators.push(new Elevator(this.elevators.length, s.id));
  }

  // =================================================================== snapshot

  applySnapshot(input: OfficeSnapshot, now: number): void {
    let snap = this.injected.rooms.length || this.injected.agents.length ? { ...input, rooms: [...input.rooms, ...this.injected.rooms], agents: [...input.agents, ...this.injected.agents] } : input;
    if (this.agentPatches.size) {
      const patches = this.agentPatches;
      snap = { ...snap, agents: snap.agents.map((a) => (patches.has(a.id) ? { ...a, ...patches.get(a.id) } : a)) };
    }
    this.lastSnapshot = input;
    this.now = now;
    const first = !this.initialized;
    this.initialized = true;
    this.accounts = new Map(snap.accounts.map((a) => [a.id, { short: a.short, color: a.color, name: a.name, ...(a.provider === 'codex' ? { provider: a.provider } : {}) }]));

    // ---- rooms
    let layoutDirty = false;
    const listed = new Set<string>();
    // in order of arrival (server slot): at the initial load the rooms take slots 0, 1, 2... in that order
    for (const r of [...snap.rooms].sort((a, b) => a.slot - b.slot)) {
      if (this.hiddenRooms.has(r.id)) continue;
      listed.add(r.id);
      const rs = this.rooms.get(r.id);
      if (!rs) {
        this.createRoom(r, first, now);
        layoutDirty = true;
        continue;
      }
      if (rs.info.name !== r.name || rs.info.seed !== r.seed) rs.version++;
      rs.info = r;
      if (!rs.listed) {
        rs.listed = true;
        rs.readyToDismantleAt = 0;
        if (rs.phase === 'dismantling') rs.rebuild(now);
      }
    }
    for (const rs of this.rooms.values()) {
      if (!listed.has(rs.id) && rs.listed) {
        rs.listed = false;
        rs.unlistedAt = now;
      }
    }
    if (layoutDirty) this.relayout();
    this.roomFx.sync(snap.rooms, input.serverTime, now);

    // ---- agents
    const seen = new Set<string>();
    const fresh: Character[] = [];
    for (const a of snap.agents) {
      seen.add(a.id);
      const ch = this.chars.get(a.id);
      if (ch) {
        this.updateAgent(ch, a, now);
        this.social.syncAgent(ch, a, now, true);
        continue;
      }
      if (a.status === 'offline' || this.forcedOffline.has(a.id) || this.hiddenRooms.has(a.roomId)) continue;
      // subagent we never saw working and that has already finished, or whose parent is leaving: doesn't come in
      if (a.status === 'done') continue;
      if (a.kind === 'sub' && a.parentId) {
        const parent = this.chars.get(a.parentId);
        if (parent && (parent.leaving || parent.gone)) continue;
      }
      const nc = this.spawn(a, first, now);
      if (nc) {
        fresh.push(nc);
        // arrived at the office: wallet with the starting balance (tasks already completed paid silently)
        this.social.syncAgent(nc, a, now, false);
      }
    }
    for (const ch of this.chars.values()) {
      if (!seen.has(ch.id) && !ch.leaving && ch.missingSince === null) ch.missingSince = now;
    }
    // modes (after all of them exist, so subagents find their parent)
    for (const ch of fresh) {
      ch.mode = this.modeOf(ch);
      this.refreshShell(ch, now);
    }
    if (first) {
      // whoever works/waits sits first; idle ones after (that way no room stays empty)
      const seated = new Set<string>();
      const order = [...fresh].sort((a, b) => Number(a.mode === 'idle') - Number(b.mode === 'idle'));
      for (const ch of order) this.placeInitial(ch, now, seated);
    }
    this.refreshRoomInfo();
    // visit: on entry, the lights already as the building is (an off building comes in dark, without the light going off)
    if (this.visit) this.applyVisitLight(now, first);
  }

  /** Reapplies the last snapshot (debugging). */
  reapply(now: number): void {
    if (this.lastSnapshot) this.applySnapshot(this.lastSnapshot, now);
  }

  private createRoom(r: RoomInfo, first: boolean, now: number): RoomState {
    let theme = FALLBACK_THEME;
    try {
      theme = this.art.roomTheme(r.seed) ?? FALLBACK_THEME;
    } catch {
      theme = FALLBACK_THEME;
    }
    // the first free slot in the building (the server slot only gives the order of arrival)
    const slot = this.freeSlot();
    const layout = layoutProjectRoom({ id: r.id, slot, seed: r.seed }, theme);
    const rs = new RoomState(r, theme, layout, first ? 'ready' : 'building', now, first, slot);
    this.rooms.set(r.id, rs);
    return rs;
  }

  /** Lowest slot without a room (counting those still being dismantled). */
  private freeSlot(): number {
    const used = new Set<number>();
    for (const r of this.rooms.values()) if (r.phase !== 'gone') used.add(r.slot);
    let slot = 0;
    while (used.has(slot)) slot++;
    return slot;
  }

  private updateAgent(ch: Character, a: AgentInfo, now: number): void {
    const prevStatus = ch.info.status;
    const hadShells = !!ch.info.shells?.length;
    const prevLook = lookSig(ch.info);
    ch.info = a;
    if (lookSig(a) !== prevLook) {
      try {
        ch.appearance = this.art.appearanceFromSeed(a.seed, { look: a.look, sub: a.kind === 'sub', parts: a.parts });
      } catch {
        // Art with a problem: the appearance that was already there stays.
      }
    }
    ch.missingSince = null;
    if (a.roomId !== ch.roomId && !ch.leaving) {
      if (ch.homeSpot) this.spots.release(ch.homeSpot, ch.id);
      ch.homeSpot = null;
      ch.roomId = a.roomId;
      this.interrupt(ch);
    }
    const act = a.activity;
    if (act && act.id !== ch.lastActivityId) {
      const firstSeen = ch.lastActivityId === null;
      ch.lastActivityId = act.id;
      if (!firstSeen) {
        ch.activityChangedAt = now;
        if (act.kind === 'done') ch.setIcon('check', 2600, now);
        if (act.kind === 'error') ch.setIcon('sweat', 2200, now);
        if (act.kind === 'delegate' && ch.info.kind === 'main' && a.status === 'working') this.planDelegate(ch, now);
        // request handled: coins for the work
        if (act.kind === 'done' && ch.info.kind === 'main') this.social.turnDone(ch, now);
      }
    }
    // end of a shell: celebrates or laments (once per notification)
    const sd = latestShellDone(a);
    if (sd && sd.at > ch.shellDoneAt) {
      ch.shellDoneAt = sd.at;
      this.reactShellDone(ch, !sd.error, now);
    }
    // shells change without the status changing (e.g. a foreground command started/ended)
    if (prevStatus !== a.status || hadShells || !!a.shells?.length || ch.mode === 'shell' || this.forcedOffline.has(ch.id)) this.refreshMode(ch);
    this.refreshShell(ch, now);
  }

  /** Recomputes the mode and interrupts the plan if it changed. */
  private refreshMode(ch: Character): void {
    if (ch.leaving) return;
    const mode = this.modeOf(ch);
    if (mode === ch.mode) return;
    const prev = ch.mode;
    ch.mode = mode;
    if (prev === 'idle' && mode !== 'idle') ch.nextOutingAt = 0;
    if (ch.icon === 'zzz') ch.setIcon(null, 0, this.now);
    this.refreshShell(ch, this.now);
    // in a hangout, idle <-> waiting for a shell changes nothing (stays in the hangout)
    if (ch.gathering && (mode === 'idle' || mode === 'shell') && (prev === 'idle' || prev === 'shell')) return;
    // work called in the middle of a hangout: tells the group before leaving
    if (ch.gathering) this.social.calledAway(ch, prev, this.now);
    // celebration/lament for the end of a shell in progress: it finishes (short, back to the desk) and the
    // planner follows the new mode; leaving doesn't wait
    if (this.now < ch.reactUntil && mode !== 'leave' && mode !== 'deliver') return;
    ch.reactUntil = 0;
    this.interrupt(ch);
  }

  private modeOf(ch: Character): Mode {
    const a = ch.info;
    if (ch.leaving) return 'leave';
    const parent = a.parentId ? this.chars.get(a.parentId) : undefined;
    const parentGone = !!parent && (parent.leaving || parent.gone);
    const missing = ch.missingSince !== null && this.now - ch.missingSince >= MISSING_DEBOUNCE_MS;
    const offline = this.forcedOffline.has(ch.id);
    if (a.kind === 'sub' && a.status === 'done' && !ch.delivered && !offline && !parentGone) return 'deliver';
    const m = modeFor(offline ? 'offline' : a.status, { kind: a.kind, missing, parentGone, shells: a.shells, now: this.now });
    if (m === 'deliver' && ch.delivered) return 'leave';
    return m;
  }

  // =================================================================== shell wait

  /** Updates the start/count/label of the shell wait (on the snapshot and when the mode changes). */
  private refreshShell(ch: Character, now: number): void {
    if (ch.mode !== 'shell') {
      ch.shellSince = 0;
      ch.shellCount = 0;
      ch.shellStage = null;
      ch.shellEnteredAt = 0;
      return;
    }
    const a = ch.info;
    if (!ch.shellEnteredAt) ch.shellEnteredAt = now;
    // server and browser clocks may differ a little: never "in the future"
    ch.shellSince = Math.min(now, shellWaitSince(a));
    ch.shellCount = Math.max(1, countShells(a.shells, a.status !== 'shell'));
    const label = shellLabel(a);
    if (label !== ch.shellLabel) {
      ch.shellLabel = label;
      ch.shellTextKey = -1;
    }
    // visit: no time came from the world, so the gag doesn't escalate (no popcorn, spin, cobweb or nap)
    ch.shellStage = this.visit ? null : shellStage(now - ch.shellSince);
  }

  /**
   * A shell ended (Activity 'ShellDone'): success -> gets up and celebrates with confetti and ⭐;
   * failure/killed -> little rain cloud ('storm') and slumped shoulders. Then follows the current status.
   */
  private reactShellDone(ch: Character, ok: boolean, now: number): void {
    if (ch.leaving || ch.mode === 'leave' || ch.mode === 'deliver') return;
    ch.setIcon(ok ? 'star' : 'storm', ok ? CHEER_MS : SULK_MS, now);
    if (ok) this.pushEffect({ kind: 'confetti', charId: ch.id, at: now });
    // only acts it out at its own desk and still; walking/on an outing, only the icon (and the confetti)
    const home = this.spots.get(ch.homeSpot);
    if (!home || ch.atSpot !== home.id || ch.step || ch.queue.length || ch.gathering) return;
    if (ok) {
      ch.reactUntil = now + CHEER_MS + 2 * ENTER_MS + 200;
      if (home.seated) ch.queue.push({ t: 'exit' });
      ch.queue.push({ t: 'act', pose: 'stretch', ms: CHEER_MS * 0.55 }, { t: 'act', pose: 'raise_hand', ms: CHEER_MS * 0.45 });
      if (home.seated) ch.queue.push({ t: 'enter', spot: home.id });
    } else {
      // head down, discouraged, without leaving the chair
      ch.reactUntil = now + SULK_MS;
      ch.queue.push({ t: 'act', pose: home.seated ? 'sleep' : 'stand', ms: SULK_MS });
    }
  }

  /** Play of the TV soccer game right now (so the fans celebrate along with the screen's "GOL"). */
  footballLance(t: number): { lance: number; progress: number; right: boolean; period: number; goalAt: number } | null {
    try {
      return this.art.footballLance?.(t, PROGRAM_SEED.futebol) ?? null;
    } catch {
      return null;
    }
  }

  /** Asks the render for a visual effect (confetti, coins, sparkle). */
  pushEffect(e: WorldEffect): void {
    if (this.effects.length >= MAX_EFFECTS) this.effects.shift();
    this.effects.push(e);
  }

  // =================================================================== birth and placement

  private spawn(a: AgentInfo, first: boolean, now: number): Character | null {
    let appearance;
    try {
      appearance = this.art.appearanceFromSeed(a.seed, { look: a.look, sub: a.kind === 'sub', parts: a.parts });
    } catch {
      return null;
    }
    const ch = new Character(a, appearance);
    ch.lastActivityId = a.activity?.id ?? null;
    ch.shellDoneAt = latestShellDone(a)?.at ?? 0;
    this.chars.set(a.id, ch);
    if (first) return ch;
    // arrival by the elevator
    const el = this.pickElevator(ch);
    const spot = this.spots.get(el.spotId)!;
    ch.placeAtTile(spot.tx, spot.ty);
    ch.x = spot.x;
    ch.y = spot.y - 6;
    ch.dir = 'down';
    ch.alpha = 0;
    ch.inside = true;
    ch.arriving = true;
    ch.hiddenUntil = el.reserveAppear(now);
    // subagents launched together don't leave the elevator at the same instant
    if (a.kind === 'sub') ch.hiddenUntil += Math.floor(ch.rng() * 600);
    ch.queue.push({ t: 'elevOut', elev: el.index, phase: 0 });
    return ch;
  }

  /**
   * Initial load: everyone starts in their natural place (their own desk), with nobody "standing in
   * the hallway". Only a minority of the truly idle (stopped for a while, not napping) shows up at a
   * couch/armchair/beanbag/coffee — never on a hallway or bathroom bench, and never emptying the room.
   */
  private placeInitial(ch: Character, now: number, roomsSeated: Set<string>): void {
    this.assignHome(ch);
    const home = this.spots.get(ch.homeSpot);
    // first outing only after a few seconds: the initial load shows everyone in place
    ch.nextOutingAt = now + INITIAL_OUTING_DELAY_MS + idleSitMs(ch.rng, this.options().liveliness) * ch.rng();
    const relaxing =
      ch.mode === 'idle' &&
      !!home &&
      roomsSeated.has(ch.roomId) &&
      now - ch.info.statusSince >= INITIAL_LOUNGE_MIN_IDLE_MS &&
      !isLongIdle(ch.info.status, ch.info.statusSince, now) &&
      ch.rng() < INITIAL_LOUNGE_SHARE;
    if (relaxing) {
      const seat = this.randomFree(INITIAL_LOUNGE_SEATS, ch);
      if (seat && this.spots.reserve(seat.id, ch.id)) {
        ch.tempSpots.push(seat.id);
        this.snapTo(ch, seat);
        const held = seat.kind === 'cafe_seat' ? 'coffee' : 'none';
        ch.queue.push({ t: 'act', pose: 'sit', held, ms: between(ch.rng, 4000, 14000) }, { t: 'exit' }, { t: 'do', fn: () => this.releaseTemp(ch) });
        return;
      }
    }
    if (home) {
      this.snapTo(ch, home);
      roomsSeated.add(ch.roomId);
    } else this.placeOverflow(ch);
  }

  /** No reserved place: standing inside their own room (if it exists) or in the reception. */
  private placeOverflow(ch: Character): void {
    const room = this.rooms.get(ch.roomId);
    const t = room && room.present ? this.overflowTile(ch, room) : null;
    ch.standTile = t;
    const p = t ?? this.lobbyTile(ch);
    ch.placeAtTile(p.x, p.y);
  }

  private snapTo(ch: Character, s: SpotDef): void {
    ch.tx = s.tx;
    ch.ty = s.ty;
    ch.x = s.x;
    ch.y = s.y;
    ch.dir = s.dir;
    ch.atSpot = s.id;
    ch.seated = !!s.seated;
    ch.sortY = s.sortY ?? null;
  }

  /** Reserves a desk (or stool/standing point) in the character's room. */
  private assignHome(ch: Character): void {
    if (ch.homeSpot && this.spots.get(ch.homeSpot) && this.spots.ownerOf(ch.homeSpot) === ch.id) return;
    ch.homeSpot = null;
    const room = this.rooms.get(ch.roomId);
    if (!room || !room.present) return;
    const seat = chooseSeat(room.layout.spots, (id) => this.spots.isFree(id, ch.id), ch.info.kind);
    if (seat && this.spots.reserve(seat.id, ch.id)) ch.homeSpot = seat.id;
  }

  private pickElevator(ch: Character): Elevator {
    let best = this.elevators[0];
    for (const e of this.elevators) if (e.load < best.load || (e.load === best.load && ch.rng() < 0.5)) best = e;
    return best;
  }

  // =================================================================== layout

  /** Recomputes the building (width, grid, spots) from the rooms present. */
  relayout(force = false): void {
    const present = [...this.rooms.values()].filter((r) => r.present);
    let cols = columnsFor(present.map((r) => r.slot));
    const cur = this.building.cols;
    if (cols < cur && !force) {
      // only shrinks when nobody is in the strip that will disappear
      const limit = cols * COL_W * TILE;
      if ([...this.chars.values()].some((c) => !c.gone && c.x >= limit - TILE)) {
        cols = cur;
        this.shrinkPending = true;
      } else this.shrinkPending = false;
    } else this.shrinkPending = false;
    const building = assembleBuilding(
      cols,
      present.map((r) => r.layout),
      this.layoutVersion + 1,
    );
    this.building = building;
    this.layoutVersion++;
    this.finder.setGrid(building.grid);
    const lost = this.spots.setSpots(building.spots);
    for (const { owner } of lost) {
      const ch = this.chars.get(owner);
      if (!ch) continue;
      if (ch.homeSpot && !this.spots.get(ch.homeSpot)) ch.homeSpot = null;
      ch.tempSpots = ch.tempSpots.filter((s) => this.spots.get(s));
    }
    for (const ch of this.chars.values()) {
      if (ch.atSpot && !this.spots.get(ch.atSpot)) {
        ch.atSpot = null;
        ch.seated = false;
        ch.sortY = null;
      }
      // paths in progress are recomputed from the current tile; a destination that no longer exists (the
      // building shrank and took the hallway water cooler, the room was dismantled) invalidates the plan: without
      // this the step wouldn't find a path and would teleport the character out of the building
      let stale = false;
      for (const s of ch.step ? [ch.step, ...ch.queue] : ch.queue) {
        if (s.t !== 'go') continue;
        s.path = undefined;
        if (!this.building.grid.nearestWalkable(s.tx, s.ty, 4)) stale = true;
      }
      if (stale) this.interrupt(ch);
      if (!this.building.grid.walkable(ch.tx, ch.ty) && !ch.atSpot && !ch.inside) {
        const n = this.building.grid.nearestWalkable(ch.tx, ch.ty);
        if (n) {
          ch.tx = n.x;
          ch.ty = n.y;
        }
      }
    }
  }

  // =================================================================== per-frame update

  update(dt: number, now: number): void {
    this.now = now;
    for (const e of this.elevators) e.update(dt, now);
    this.updateRooms(now);
    this.social.update(now);
    if (this.roomFx.active.size) this.roomFx.update(this, now);
    for (const ch of this.chars.values()) {
      if (ch.missingSince !== null && !ch.leaving && now - ch.missingSince >= MISSING_DEBOUNCE_MS) this.refreshMode(ch);
      this.runCharacter(ch, dt, now);
    }
    if (this.visitor) this.runVisitor(this.visitor, dt, now);
    for (const [id, ch] of this.chars) {
      if (ch.gone) {
        this.spots.releaseAll(id);
        this.chars.delete(id);
      }
    }
    if (now >= this.nextHousekeeping) {
      this.nextHousekeeping = now + 1000;
      this.housekeeping(now);
    }
  }

  /** Low-frequency checks (parent leaving, rooms without an owner, shrinking the building). */
  private housekeeping(now: number): void {
    for (const ch of this.chars.values()) {
      if (ch.info.kind === 'sub' && !ch.leaving) this.refreshMode(ch);
      // foreground command passed 10 s (or the wait ended): changes mode without a new snapshot
      else if (!ch.leaving && (ch.mode === 'shell' || (ch.info.status === 'working' && ch.info.shells?.length))) this.refreshMode(ch);
      if (ch.mode === 'idle' && this.longIdle(ch, now) && ch.atSpot === ch.homeSpot && ch.pose === 'sleep' && ch.icon !== 'zzz') {
        ch.setIcon('zzz', 1e12, now);
      }
    }
    if (this.shrinkPending) this.relayout();
    this.social.housekeeping(now);
    for (const [id, until] of this.machineUntil) if (until < now) this.machineUntil.delete(id);
    this.refreshRoomInfo();
    if (this.visit) this.applyVisitLight(now);
  }

  private updateRooms(now: number): void {
    let dirty = false;
    for (const room of this.rooms.values()) {
      if (room.phase === 'building' && room.progress(now) >= 1) room.setPhase('ready', now);
      if (room.phase === 'dismantling' && room.progress(now) >= 1) {
        room.setPhase('gone', now);
        dirty = true;
      }
      if (!room.listed && (room.phase === 'ready' || room.phase === 'building')) {
        const occupants = this.occupants(room);
        // safety: room with nobody and light on with nobody to turn it off
        if (occupants === 0 && room.lightOn && !this.switchClaimValid(room) && now - room.unlistedAt > 2500) room.setLight(false, now);
        const ok = canDismantle({ listed: room.listed, occupants, lightOn: room.lightOn, dark: room.light(now) <= 0.01, unlistedForMs: now - room.unlistedAt }, 0);
        if (!ok) room.readyToDismantleAt = 0;
        else if (!room.readyToDismantleAt) room.readyToDismantleAt = now;
        else if (now - room.readyToDismantleAt >= DISMANTLE_DELAY_MS) room.setPhase('dismantling', now);
      }
    }
    for (const [id, room] of this.rooms) {
      if (room.phase === 'gone') {
        this.rooms.delete(id);
        dirty = true;
      }
    }
    if (dirty) this.relayout();
    this.compact(now);
  }

  // =================================================================== room move

  /**
   * No gaps between the rooms: when a slot becomes free before the last room (a terminal closed and the
   * room was dismantled), the farthest room moves to it after COMPACT_DELAY_MS. One room at a time,
   * only a ready room with its session open; the building shrinks when the old address is dismantled.
   */
  private compact(now: number): void {
    const free = this.freeSlot();
    let far: RoomState | null = null;
    for (const r of this.rooms.values()) {
      if (r.slot > free && !r.ghost && r.listed && r.phase === 'ready' && (!far || r.slot > far.slot)) far = r;
    }
    if (!far) {
      this.gapSince = 0;
      return;
    }
    if (!this.gapSince) this.gapSince = now;
    if (now - this.gapSince < COMPACT_DELAY_MS) return;
    this.gapSince = 0;
    this.moveRoom(far, free, now);
  }

  /**
   * Moves the room to another slot: it is built again there (dark; the first to arrive turns on the light)
   * and the old address becomes a ghost room that waits to empty, goes dark and is dismantled. The places
   * keep their ids (each one keeps their own desk, now in the new room); whoever is seated or on the way
   * to a place in the room starts using the equivalent place in the ghost, gets up from there and walks over.
   */
  moveRoom(room: RoomState, slot: number, now: number): void {
    const before = room.layout;
    const ghostId = `${room.id}#mudança${++this.moveSeq}`;
    const ghostLayout = layoutProjectRoom({ id: ghostId, slot: room.slot, seed: room.seed }, room.theme);
    const ghost = new RoomState({ ...room.info, id: ghostId, seed: room.seed }, room.theme, ghostLayout, 'ready', now, false, room.slot);
    ghost.ghost = true;
    ghost.listed = false;
    ghost.unlistedAt = now;
    ghost.lightOn = room.lightOn;
    ghost.lightAt = room.lightAt;
    this.rooms.set(ghostId, ghost);
    // the layout is deterministic by the seed: the i-th place of the ghost is the i-th of the old room
    const alias = new Map<string, string>();
    before.spots.forEach((s, i) => {
      const g = ghostLayout.spots[i];
      if (g && g.kind === s.kind) alias.set(s.id, g.id);
    });

    room.slot = slot;
    room.layout = layoutProjectRoom({ id: room.id, slot, seed: room.seed }, room.theme);
    room.setPhase('building', now);
    room.lightOn = false;
    room.lightAt = -1e9;
    room.switchClaim = null;
    room.readyToDismantleAt = 0;
    room.version++;
    this.relayout();
    // the ghost's places belong to nobody (no outing or hangout will end up there)
    for (const s of ghostLayout.spots) this.spots.reserve(s.id, GHOST_OWNER);

    for (const ch of this.chars.values()) {
      if (ch.gone) continue;
      let touched = false;
      if (ch.atSpot && alias.has(ch.atSpot)) {
        ch.atSpot = alias.get(ch.atSpot)!;
        touched = true;
      }
      // on the way to a place, to the switch or to a corner of the old room: the plan goes stale (the step that
      // can't be interrupted ends at the old address: sits in the ghost, works the ghost's light)
      for (const step of ch.step ? [ch.step, ...ch.queue] : ch.queue) {
        if (step.t === 'enter' && alias.has(step.spot)) {
          step.spot = alias.get(step.spot)!;
          touched = true;
        } else if (step.t === 'switch' && step.room === room.id) {
          step.room = ghostId;
          touched = true;
        } else if (step.t === 'go' && inRect(before.rect, step.tx, step.ty)) touched = true;
      }
      if (ch.tempSpots.some((id) => alias.has(id))) touched = true;
      if (touched || (ch.roomId === room.id && ch.standTile) || inRect(before.rect, ch.tx, ch.ty)) {
        ch.standTile = null;
        this.interrupt(ch);
      }
    }
  }

  private switchClaimValid(room: RoomState): boolean {
    if (!room.switchClaim) return false;
    const c = this.chars.get(room.switchClaim);
    if (!c || c.gone) {
      room.switchClaim = null;
      return false;
    }
    return true;
  }

  /** Characters associated with the room (not leaving) + anyone physically inside it. */
  occupants(room: RoomState, except?: string): number {
    let n = 0;
    for (const c of this.chars.values()) {
      if (c.gone || c.id === except) continue;
      if ((c.roomId === room.id && !c.leaving) || inRect(room.layout.rect, c.tx, c.ty)) n++;
    }
    return n;
  }

  /** How many are physically inside the room's rectangle. */
  private physicallyInside(room: RoomState, except?: string): number {
    let n = 0;
    for (const c of this.chars.values()) if (!c.gone && c.id !== except && inRect(room.layout.rect, c.tx, c.ty)) n++;
    return n;
  }

  /** Accounts present and kanban board of each room. */
  private refreshRoomInfo(): void {
    for (const room of this.rooms.values()) {
      const accs = new Set<string>();
      const board: RoomState['board'] = [];
      for (const c of this.chars.values()) {
        if (c.roomId !== room.id || c.leaving) continue;
        accs.add(c.info.account);
        if (c.info.kind === 'main') for (const t of c.info.tasks) if (board.length < 15) board.push({ status: t.status });
      }
      room.accounts = [...accs].sort();
      room.board = board;
    }
  }

  // =================================================================== step execution

  private runCharacter(ch: Character, dt: number, now: number): void {
    // animation
    ch.animT += dt * 1000;
    ch.updateLane(dt);
    if (ch.icon && now >= ch.iconUntil) ch.icon = null;
    // "zzz" only while sleeping: whoever gets up (a hangout called, party in the room, an outing) woke up, and the
    // icon doesn't go along. The nap at the desk of whoever has been idle for a long time doesn't change the mode,
    // so nobody else would clear it.
    if (ch.icon === 'zzz' && ch.pose !== 'sleep') ch.icon = null;
    if (ch.mode === 'shell' && ch.shellSince && !this.visit) ch.shellStage = shellStage(now - ch.shellSince);
    if (!ch.step) {
      if (ch.replan) {
        ch.replan = false;
        this.clearPlan(ch);
      }
      ch.step = ch.queue.shift() ?? null;
      ch.stepT = 0;
      ch.stepStarted = false;
    }
    if (ch.step) {
      const done = this.runStep(ch, ch.step, dt, now);
      ch.stepT += dt * 1000;
      if (done) {
        ch.step = null;
        if (ch.replan) {
          ch.replan = false;
          this.clearPlan(ch);
        }
      }
      return;
    }
    // empty queue: decides the next plan or rests
    if (now >= ch.thinkAt) {
      const planned = this.think(ch, now);
      if (!planned) ch.thinkAt = now + 400;
    }
    if (!ch.step && !ch.queue.length) this.restPose(ch, now);
  }

  private runStep(ch: Character, s: Step, dt: number, now: number): boolean {
    const first = !ch.stepStarted;
    ch.stepStarted = true;
    switch (s.t) {
      case 'go':
        return this.stepGo(ch, s, dt);
      case 'enter': {
        const spot = this.spots.get(s.spot);
        if (!spot) return true;
        if (first) {
          ch.enterFrom = { x: ch.x, y: ch.y };
          if (spot.seated) ch.sortY = spot.sortY ?? null;
        }
        const k = Math.min(1, (ch.stepT + dt * 1000) / ENTER_MS);
        const from = ch.enterFrom ?? { x: ch.x, y: ch.y };
        ch.x = from.x + (spot.x - from.x) * k;
        ch.y = from.y + (spot.y - from.y) * k;
        if (k >= 1) {
          this.snapTo(ch, spot);
          ch.setPose(spot.seated ? 'sit' : 'stand', ch.held);
          return true;
        }
        return false;
      }
      case 'exit': {
        if (!ch.atSpot) return true;
        const spot = this.spots.get(ch.atSpot);
        if (!spot) {
          ch.atSpot = null;
          ch.seated = false;
          ch.sortY = null;
          return true;
        }
        const tx = spot.tx * TILE + FOOT_DX;
        const ty = spot.ty * TILE + FOOT_DY;
        if (first) ch.enterFrom = { x: ch.x, y: ch.y };
        const k = Math.min(1, (ch.stepT + dt * 1000) / ENTER_MS);
        const from = ch.enterFrom ?? { x: ch.x, y: ch.y };
        ch.x = from.x + (tx - from.x) * k;
        ch.y = from.y + (ty - from.y) * k;
        ch.seated = false;
        ch.setPose('stand', ch.held);
        if (k >= 1) {
          ch.atSpot = null;
          ch.sortY = null;
          ch.tx = spot.tx;
          ch.ty = spot.ty;
          return true;
        }
        return false;
      }
      case 'act': {
        if (first) {
          if (s.dir) ch.dir = s.dir;
          if (s.icon) ch.setIcon(s.icon, s.ms, now);
          if (s.machine) this.machineUntil.set(s.machine, now + s.ms);
        }
        ch.setPose(s.pose, s.held ?? 'none');
        return ch.stepT >= s.ms;
      }
      case 'until': {
        if (first && s.dir) ch.dir = s.dir;
        ch.setPose(s.pose ?? (ch.seated ? 'sit' : 'stand'), s.held ?? ch.held);
        if (ch.stepT >= s.maxMs) return true;
        return ch.stepT >= s.minMs && s.cond();
      }
      case 'elevOut':
        return this.stepElevOut(ch, s, dt, now);
      case 'elevIn':
        return this.stepElevIn(ch, s, dt, now);
      case 'stall':
        return this.stepStall(ch, s, dt, now);
      case 'switch':
        return this.stepSwitch(ch, s, now);
      case 'gather':
        return this.social.stepGather(ch, s.g, now);
      case 'do':
        s.fn();
        return true;
      case 'remove':
        ch.gone = true;
        return true;
    }
  }

  private findPath(sx: number, sy: number, gx: number, gy: number, out: number[]): boolean {
    const grid = this.building.grid;
    if (!grid.walkable(gx, gy)) {
      const n = grid.nearestWalkable(gx, gy, 4);
      if (!n) return false;
      gx = n.x;
      gy = n.y;
    }
    if (this.finder.find(sx, sy, gx, gy, out)) return true;
    const s = grid.nearestWalkable(sx, sy, 6);
    if (s && (s.x !== sx || s.y !== sy) && this.finder.find(s.x, s.y, gx, gy, out)) {
      out.unshift(s.x, s.y);
      return true;
    }
    return false;
  }

  private stepGo(ch: Character, s: Extract<Step, { t: 'go' }>, dt: number): boolean {
    if (!s.path) {
      s.path = [];
      s.i = 0;
      if (!this.findPath(ch.tx, ch.ty, s.tx, s.ty, s.path)) {
        // no path (shouldn't happen): teleports so it doesn't get stuck
        ch.placeAtTile(s.tx, s.ty);
        s.path.length = 0;
      }
    }
    const path = s.path;
    let budget = (s.run ? RUN_SPEED : WALK_SPEED) * ch.speedK * dt;
    let moved = false;
    while (budget > 0.0001) {
      let gx: number;
      let gy: number;
      const i = s.i ?? 0;
      if (i < path.length) {
        ch.tx = path[i];
        ch.ty = path[i + 1];
        gx = ch.tx * TILE + FOOT_DX;
        gy = ch.ty * TILE + FOOT_DY;
      } else if (s.fx !== undefined && s.fy !== undefined && !s.fine) {
        gx = s.fx;
        gy = s.fy;
      } else break;
      const dx = gx - ch.x;
      const dy = gy - ch.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.001) ch.dir = dirOf(dx, dy, ch.dir);
      if (d <= budget) {
        ch.x = gx;
        ch.y = gy;
        budget -= d;
        if (i < path.length) s.i = i + 2;
        else s.fine = true;
      } else {
        ch.x += (dx / d) * budget;
        ch.y += (dy / d) * budget;
        budget = 0;
      }
      moved = true;
    }
    const arrived = (s.i ?? 0) >= path.length && (s.fx === undefined || s.fine);
    if (arrived) {
      if (s.dir) ch.dir = s.dir;
      ch.setPose('stand', s.held ?? 'none');
      return true;
    }
    if (moved) ch.setPose(s.run ? 'run' : 'walk', s.held ?? 'none');
    return false;
  }

  private stepElevOut(ch: Character, s: Extract<Step, { t: 'elevOut' }>, dt: number, now: number): boolean {
    const el = this.elevators[s.elev] ?? this.elevators[0];
    const spot = this.spots.get(el.spotId)!;
    ch.dir = 'down';
    if (s.phase === 0) {
      ch.alpha = 0;
      ch.setPose('stand');
      if (now >= ch.hiddenUntil) {
        el.request(ch.id);
        s.phase = 1;
      }
      return false;
    }
    if (s.phase === 1) {
      ch.x = spot.x;
      ch.y = spot.y - 6;
      if (el.door >= 2.5) {
        ch.inside = false;
        ch.alpha = Math.min(1, ch.alpha + dt * 5);
        if (ch.alpha >= 1 && el.isOpen) s.phase = 2;
      }
      return false;
    }
    // leaves the elevator to the tile in front
    const gx = spot.tx * TILE + FOOT_DX;
    const gy = spot.ty * TILE + FOOT_DY;
    const dx = gx - ch.x;
    const dy = gy - ch.y;
    const d = Math.hypot(dx, dy);
    const step = WALK_SPEED * dt;
    ch.alpha = 1;
    if (d <= step) {
      ch.x = gx;
      ch.y = gy;
      ch.tx = spot.tx;
      ch.ty = spot.ty;
      el.release(ch.id, now);
      ch.setPose('stand');
      return true;
    }
    ch.x += (dx / d) * step;
    ch.y += (dy / d) * step;
    ch.setPose('walk');
    return false;
  }

  private stepElevIn(ch: Character, s: Extract<Step, { t: 'elevIn' }>, dt: number, now: number): boolean {
    const el = this.elevators[s.elev] ?? this.elevators[0];
    const spot = this.spots.get(el.spotId)!;
    if (s.phase === 0) {
      ch.dir = 'up';
      ch.setPose('stand');
      el.request(ch.id);
      if (el.isOpen) s.phase = 1;
      return false;
    }
    if (s.phase === 1) {
      const gx = spot.x;
      const gy = spot.y - 6;
      const dx = gx - ch.x;
      const dy = gy - ch.y;
      const d = Math.hypot(dx, dy);
      const step = WALK_SPEED * dt;
      ch.dir = 'up';
      if (d <= step) {
        ch.x = gx;
        ch.y = gy;
        s.phase = 2;
        ch.dir = 'down';
        ch.setPose('stand');
      } else {
        ch.x += (dx / d) * step;
        ch.y += (dy / d) * step;
        ch.setPose('walk');
      }
      return false;
    }
    ch.alpha = Math.max(0, ch.alpha - dt * 3.5);
    if (ch.alpha <= 0) {
      ch.inside = true;
      el.release(ch.id, now);
      return true;
    }
    return false;
  }

  private stepStall(ch: Character, s: Extract<Step, { t: 'stall' }>, dt: number, now: number): boolean {
    const spot = this.spots.get(s.spot);
    if (!spot) return true;
    const furn = spot.furnitureId ?? spot.id;
    const ax = spot.tx * TILE + FOOT_DX;
    const ay = spot.ty * TILE + FOOT_DY;
    if (s.phase === 0) {
      // goes in through the door (moves up a bit) and disappears
      const dx = spot.x - ch.x;
      const dy = spot.y - ch.y;
      const d = Math.hypot(dx, dy);
      const step = WALK_SPEED * 0.8 * dt;
      ch.dir = 'up';
      ch.setPose('walk');
      if (d > step) {
        ch.x += (dx / d) * step;
        ch.y += (dy / d) * step;
      } else {
        ch.x = spot.x;
        ch.y = spot.y;
      }
      ch.alpha = Math.max(0, ch.alpha - dt * 4);
      if (d <= step && ch.alpha <= 0) {
        ch.inside = true;
        this.stallBusy.add(furn);
        s.phase = 1;
        ch.stallUntil = now + s.ms;
      }
      return false;
    }
    if (s.phase === 1) {
      if (now >= (ch.stallUntil ?? 0)) {
        s.phase = 2;
        this.stallBusy.delete(furn);
        ch.inside = false;
        ch.dir = 'down';
      }
      return false;
    }
    // leaves the stall
    const dx = ax - ch.x;
    const dy = ay - ch.y;
    const d = Math.hypot(dx, dy);
    const step = WALK_SPEED * 0.8 * dt;
    ch.alpha = Math.min(1, ch.alpha + dt * 4);
    ch.dir = 'down';
    ch.setPose('walk');
    if (d > step) {
      ch.x += (dx / d) * step;
      ch.y += (dy / d) * step;
      return false;
    }
    ch.x = ax;
    ch.y = ay;
    ch.alpha = 1;
    ch.tx = spot.tx;
    ch.ty = spot.ty;
    ch.setPose('stand');
    return true;
  }

  private stepSwitch(ch: Character, s: Extract<Step, { t: 'switch' }>, now: number): boolean {
    const room = this.rooms.get(s.room);
    if (!room) return true;
    const spot = room.layout.spots.find((p) => p.kind === 'switch');
    if (spot) ch.dir = spot.dir;
    if (s.phase === 0) {
      ch.setPose('use');
      if (ch.stepT >= 420) {
        s.phase = 1;
        const stillLast = !s.onlyIfLast || isLastInRoom(room.id, ch.id, this.chars.values());
        if (stillLast && (s.on ? room.present : true)) room.setLight(s.on, now);
      }
      return false;
    }
    ch.setPose('use');
    if (ch.stepT >= 700) {
      ch.setPose('stand');
      return true;
    }
    return false;
  }

  // =================================================================== planning

  /** Interrupts the current plan (respecting steps that need to finish). */
  interrupt(ch: Character): void {
    if (ch.step && !this.interruptible(ch.step)) {
      ch.replan = true;
      if (ch.step.t === 'stall' && ch.step.phase <= 1) ch.stallUntil = Math.min(ch.stallUntil ?? 0, this.now + 2000);
      return;
    }
    this.clearPlan(ch);
  }

  interruptible(s: Step): boolean {
    return s.t === 'go' || s.t === 'act' || s.t === 'until' || s.t === 'gather' || s.t === 'do';
  }

  /** Discards the queue (and leaves the hangout, if in one). */
  clearPlan(ch: Character): void {
    ch.queue.length = 0;
    ch.step = null;
    ch.thinkAt = 0;
    this.releaseTemp(ch);
    // the 'do' step that would release the switch was discarded along with the queue: without this the
    // reservation leaks and nobody else turns on (or off) the room's light while this character exists
    const room = this.rooms.get(ch.roomId);
    if (room && room.switchClaim === ch.id) room.switchClaim = null;
    if (ch.gathering) this.social.leave(ch, this.now);
    ch.chatUntil = 0;
  }

  releaseTemp(ch: Character): void {
    for (const id of ch.tempSpots) if (id !== ch.homeSpot) this.spots.release(id, ch.id);
    ch.tempSpots.length = 0;
  }

  reserveTemp(ch: Character, spot: SpotDef): boolean {
    if (!this.spots.reserve(spot.id, ch.id)) return false;
    ch.tempSpots.push(spot.id);
    return true;
  }

  /** Decides the next plan. Returns true if it planned something. */
  private think(ch: Character, now: number): boolean {
    if (ch.gone) return false;
    if (ch.mode === 'leave') return this.planLeave(ch, now);
    if (ch.mode === 'deliver') return this.planDeliver(ch, now);
    const room = this.rooms.get(ch.roomId);
    if (!room || !room.present) return this.planLobby(ch, room);
    this.assignHome(ch);
    if (!ch.homeSpot) return this.planOverflow(ch, room);
    ch.standTile = null;
    // dark room: the first to arrive turns on the light
    if (!room.lightOn && room.phase !== 'dismantling' && !this.switchClaimValid(room)) {
      room.switchClaim = ch.id;
      const sw = room.layout.spots.find((p) => p.kind === 'switch');
      if (sw) {
        const steps: Step[] = [];
        this.pushLeave(ch, steps);
        steps.push(
          { t: 'go', tx: sw.tx, ty: sw.ty, fx: sw.x, fy: sw.y, dir: sw.dir, run: ch.mode === 'wait' },
          { t: 'until', cond: () => room.phase === 'ready', minMs: 0, maxMs: 6000, dir: sw.dir },
          { t: 'switch', room: room.id, on: true, phase: 0 },
          { t: 'do', fn: () => room.switchClaim === ch.id && (room.switchClaim = null) },
        );
        ch.queue.push(...steps);
        return true;
      }
    }
    if (ch.atSpot !== ch.homeSpot) return this.planGoHome(ch, now);
    ch.arriving = false;
    if (ch.mode === 'idle' && !this.longIdle(ch, now)) {
      if (!ch.nextOutingAt) ch.nextOutingAt = now + idleSitMs(ch.rng, this.options().liveliness);
      if (now >= ch.nextOutingAt) {
        if (this.planOuting(ch, now)) return true;
        ch.nextOutingAt = now + idleSitMs(ch.rng, this.options().liveliness);
      }
    }
    // waiting for a shell: only leaves the desk for a hangout (alone, stays with the popcorn)
    if (ch.mode === 'shell') {
      if (!ch.nextSocialAt) ch.nextSocialAt = now + idleSitMs(ch.rng, this.options().liveliness) * 1.3;
      if (now >= ch.nextSocialAt) {
        ch.nextSocialAt = now + idleSitMs(ch.rng, this.options().liveliness) * 1.3;
        const p = personaFor(ch.info.seed);
        if (this.social.hasCompany(ch, now) && ch.rng() < 0.5 + p.sociability * 0.4 && this.social.tryInitiate(ch, now, true)) return true;
      }
    }
    return false;
  }

  /** Get up/leave the current place before walking. */
  private pushLeave(ch: Character, steps: Step[]): void {
    if (ch.atSpot) steps.push({ t: 'exit' });
  }

  private planGoHome(ch: Character, now: number, held: 'none' | 'coffee' | 'water' = 'none'): boolean {
    const home = this.spots.get(ch.homeSpot);
    if (!home) return false;
    const steps: Step[] = [];
    this.pushLeave(ch, steps);
    const dist = Math.abs(home.tx - ch.tx) + Math.abs(home.ty - ch.ty);
    // whoever just arrived walks (unless they need the user); after that, runs if far away
    const run = shouldRun(dist, ch.mode) && (!ch.arriving || ch.mode === 'wait');
    steps.push({ t: 'go', tx: home.tx, ty: home.ty, run, held }, { t: 'enter', spot: home.id });
    if (ch.mode === 'idle') steps.push({ t: 'do', fn: () => (ch.nextOutingAt = this.now + idleSitMs(ch.rng, this.options().liveliness)) });
    void now;
    ch.queue.push(...steps);
    return true;
  }

  /** No room yet (waiting for a slot): waits in the reception. */
  private planLobby(ch: Character, room: RoomState | undefined): boolean {
    const t = this.lobbyTile(ch);
    ch.queue.push(
      { t: 'go', tx: t.x, ty: t.y },
      { t: 'until', cond: () => !!room && room.present, minMs: 800, maxMs: 4000, dir: 'down' },
    );
    return true;
  }

  /**
   * Full room (all places reserved): works standing inside their own room, in a free
   * corner, until a place frees up. Never wanders around the reception.
   */
  private planOverflow(ch: Character, room: RoomState): boolean {
    const stay = ch.standTile && !ch.atSpot && ch.tx === ch.standTile.x && ch.ty === ch.standTile.y && this.overflowFree(ch.tx, ch.ty, ch);
    const t = stay ? ch.standTile : this.overflowTile(ch, room);
    if (!t) return this.planLobby(ch, room);
    ch.standTile = t;
    ch.arriving = false;
    const steps: Step[] = [];
    this.pushLeave(ch, steps);
    const r = room.layout.rect;
    // facing the middle of the room (where the desks are)
    const dir: Dir = facing(t.x * TILE, t.y * TILE, (r.x + 5) * TILE, (r.y + 6) * TILE);
    if (t.x !== ch.tx || t.y !== ch.ty || ch.atSpot) {
      const dist = Math.abs(t.x - ch.tx) + Math.abs(t.y - ch.ty);
      steps.push({ t: 'go', tx: t.x, ty: t.y, dir, run: shouldRun(dist, ch.mode) });
    }
    // waiting for a shell standing up: only the hourglass (the wait pose is seated)
    const pose = ch.mode === 'wait' ? 'raise_hand' : ch.mode === 'work' ? 'read' : 'stand';
    const held = ch.mode === 'work' ? 'laptop' : 'none';
    steps.push({ t: 'until', cond: () => this.hasFreeSeat(room, ch), minMs: 1500, maxMs: 12_000, pose, held, dir });
    ch.queue.push(...steps);
    return true;
  }

  private hasFreeSeat(room: RoomState, ch: Character): boolean {
    return !!chooseSeat(room.layout.spots, (id) => this.spots.isFree(id, ch.id), ch.info.kind);
  }

  /** Free tile for someone to stand on (no seat, no spot and no other person). */
  private overflowFree(x: number, y: number, ch: Character, busy = this.busyTiles(ch.id)): boolean {
    const grid = this.building.grid;
    if (grid.get(x, y) !== FREE || busy.has(y * grid.w + x)) return false;
    for (const s of this.spots.all()) if (s.tx === x && s.ty === y) return false;
    return true;
  }

  /** Best free tile in the room to work standing up: next to walls/furniture, far from the door. */
  private overflowTile(ch: Character, room: RoomState): { x: number; y: number } | null {
    const grid = this.building.grid;
    const r = room.layout.rect;
    const door = room.layout.door;
    const busy = this.busyTiles(ch.id);
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    for (let y = r.y + 2; y <= r.y + 10; y++) {
      for (let x = r.x + 1; x <= r.x + 14; x++) {
        if (!this.overflowFree(x, y, ch, busy)) continue;
        if (door && Math.abs(x - (door.x + door.w / 2 - 0.5)) <= 1.5 && Math.abs(y - (door.y + door.h / 2 - 0.5)) <= 2) continue;
        // with the back to a wall/piece of furniture looks natural; squeezed between two pieces of furniture or
        // right up against another person, it doesn't
        const solidAt = (dx: number, dy: number) => grid.get(x + dx, y + dy) === BLOCKED;
        let crowd = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) if (busy.has((y + dy) * grid.w + x + dx)) crowd++;
        const backed = solidAt(0, -1) || solidAt(0, 1) ? 2 : solidAt(1, 0) || solidAt(-1, 0) ? 1 : 0;
        const squeezed = (solidAt(1, 0) && solidAt(-1, 0)) || (solidAt(0, 1) && solidAt(0, -1)) ? 3 : 0;
        const score = backed - squeezed - crowd * 3 - (Math.abs(x - ch.tx) + Math.abs(y - ch.ty)) * 0.05 + ch.rng() * 0.8;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best;
  }

  private lobbyTile(ch: Character): { x: number; y: number } {
    const reception = this.building.core.find((a) => a.id === RECEPTION_ID)!;
    const r = reception.rect;
    for (let k = 0; k < 20; k++) {
      const x = r.x + 2 + Math.floor(ch.rng() * 12);
      const y = r.y + 3 + Math.floor(ch.rng() * 7);
      if (this.building.grid.get(x, y) === 1) return { x, y };
    }
    return { x: r.x + 6, y: r.y + 9 };
  }

  private planDelegate(ch: Character, now: number): void {
    if (ch.step || ch.queue.length || ch.atSpot !== ch.homeSpot || !ch.homeSpot) return;
    const room = this.rooms.get(ch.roomId);
    const door = room?.layout.door;
    const dir: Dir = door ? facing(ch.x, ch.y, (door.x + door.w / 2) * TILE, (door.y + door.h / 2) * TILE) : 'down';
    const home = ch.homeSpot;
    ch.queue.push(
      { t: 'exit' },
      {
        // standing, facing the door, "explaining" the task to whoever arrives ('raise_hand' and ✋ stay
        // reserved for when the agent needs the user)
        t: 'until',
        cond: () => ![...this.chars.values()].some((c) => c.info.parentId === ch.id && c.arriving),
        minMs: 2600,
        maxMs: 7500,
        pose: 'talk',
        held: 'none',
        dir,
      },
      { t: 'go', tx: ch.tx, ty: ch.ty },
      { t: 'enter', spot: home },
    );
    ch.setIcon('chat', 2600, now);
  }

  private planLeave(ch: Character, now: number): boolean {
    ch.leaving = true;
    ch.arriving = false;
    this.spots.releaseAll(ch.id);
    ch.homeSpot = null;
    ch.tempSpots.length = 0;
    if (ch.gathering) this.social.leave(ch, now);
    const steps: Step[] = [];
    this.pushLeave(ch, steps);
    const room = this.rooms.get(ch.roomId);
    if (room && room.present && room.lightOn && !this.switchClaimValid(room) && isLastInRoom(room.id, ch.id, this.chars.values())) {
      const sw = room.layout.spots.find((p) => p.kind === 'switch');
      if (sw) {
        room.switchClaim = ch.id;
        steps.push(
          { t: 'go', tx: sw.tx, ty: sw.ty, fx: sw.x, fy: sw.y, dir: sw.dir },
          { t: 'until', cond: () => this.physicallyInside(room, ch.id) === 0, minMs: 250, maxMs: 9000, dir: sw.dir },
          { t: 'switch', room: room.id, on: false, phase: 0, onlyIfLast: true },
          { t: 'do', fn: () => room.switchClaim === ch.id && (room.switchClaim = null) },
        );
      }
    }
    const el = this.pickElevator(ch);
    const es = this.spots.get(el.spotId)!;
    steps.push({ t: 'go', tx: es.tx, ty: es.ty, fx: es.tx * TILE + FOOT_DX + (es.x - (es.tx * TILE + FOOT_DX)) * 0.5, fy: es.ty * TILE + FOOT_DY - 2, dir: 'up' });
    steps.push({ t: 'elevIn', elev: el.index, phase: 0 }, { t: 'remove' });
    ch.queue.push(...steps);
    void now;
    return true;
  }

  private planDeliver(ch: Character, now: number): boolean {
    const parent = ch.info.parentId ? this.chars.get(ch.info.parentId) : undefined;
    if (!parent || parent.leaving || parent.gone) {
      ch.delivered = true;
      ch.mode = 'leave';
      return this.planLeave(ch, now);
    }
    const target = this.besideTile(parent, ch);
    const steps: Step[] = [];
    this.pushLeave(ch, steps);
    const held = ch.rng() < 0.5 ? 'papers' : 'box';
    const title = ch.info.title ?? tr('result');
    steps.push(
      { t: 'go', tx: target.x, ty: target.y, held },
      {
        t: 'do',
        fn: () => {
          ch.dir = facing(ch.x, ch.y, parent.x, parent.y);
          ch.showBubble('📦', tr('Delivering: {0}', [title]), 3000, this.now);
          ch.setIcon('box', 2800, this.now);
          parent.setIcon(parent.rng() < 0.5 ? 'heart' : 'check', 2800, this.now);
        },
      },
      { t: 'act', pose: 'talk', held, ms: 2700 },
      {
        t: 'do',
        fn: () => {
          ch.delivered = true;
          ch.mode = 'leave';
          this.social.delivered(ch, this.now);
        },
      },
    );
    ch.queue.push(...steps);
    return true;
  }

  /** Walkable tile next to someone (avoiding seats and occupied tiles), the closest to whoever is coming. */
  private besideTile(target: Character, from: Character): { x: number; y: number } {
    const grid = this.building.grid;
    const busy = this.busyTiles(from.id, target.id);
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, 1],
      [0, -1],
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ] as const) {
      const x = target.tx + dx;
      const y = target.ty + dy;
      const cell = grid.get(x, y);
      if (cell === 0) continue;
      const d = Math.abs(x - from.tx) + Math.abs(y - from.ty) + (cell === SEAT ? 20 : 0) + (busy.has(y * grid.w + x) ? 40 : 0) + (dx && dy ? 3 : 0);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
    return best ?? grid.nearestWalkable(target.tx, target.ty) ?? { x: target.tx, y: target.ty };
  }

  /** Tiles (index y*w+x) where someone is stopped or going to stop, except `a` and `b`. */
  busyTiles(a: string, b?: string): Set<number> {
    const w = this.building.grid.w;
    const out = new Set<number>();
    for (const c of this.chars.values()) {
      if (c.gone || c.id === a || c.id === b) continue;
      out.add(c.ty * w + c.tx);
      const go = c.step?.t === 'go' ? c.step : c.queue.find((s): s is Extract<Step, { t: 'go' }> => s.t === 'go');
      if (go) out.add(go.ty * w + go.tx);
      if (c.standTile) out.add(c.standTile.y * w + c.standTile.x);
    }
    return out;
  }

  private randomFree(kinds: SpotKind[], ch: Character): SpotDef | null {
    const cands: SpotDef[] = [];
    for (const k of kinds) for (const s of this.spots.ofKind(k)) if (this.spots.isFree(s.id, ch.id)) cands.push(s);
    if (!cands.length) return null;
    return cands[Math.floor(ch.rng() * cands.length)];
  }

  private planOuting(ch: Character, now: number): boolean {
    const near = { tx: ch.tx, ty: ch.ty };
    const rng = ch.rng;
    const persona = personaFor(ch.info.seed);
    // colleagues with nothing to do: the urge is for company (the personality sets the dose) — TV, game, chat, bet...
    if (this.social.hasCompany(ch, now) && rng() < 0.45 + persona.sociability * 0.4 && this.social.tryInitiate(ch, now, false)) return true;
    const avail: Partial<Record<IdleActivity, boolean>> = {
      coffee: !!this.spots.findFree('coffee', { by: ch.id }),
      water: !!this.spots.findFree('water', { by: ch.id }),
      bathroom: !!this.spots.findFree('stall', { by: ch.id }),
      lounge: LOUNGE_SEATS.some((k) => !!this.spots.findFree(k, { by: ch.id })),
      // games and conversations are hangouts (social/): here only what one does alone
      pingpong: false,
      talk: false,
      window: !!this.spots.findFree('window', { by: ch.id }),
      shelf: !!this.spots.findFree('shelf', { by: ch.id }),
      arcade: !!this.spots.findFree('arcade', { by: ch.id }),
      snack: !!this.spots.findFree('snack', { by: ch.id }),
      stretch: true,
      mirror: !!this.social.plan('mirror', 1, ch),
      phone: !!this.randomFree(PHONE_SEATS, ch),
    };
    const what = pickIdleActivity(rng, avail, soloWeights(persona));
    if (!what) return false;
    const steps: Step[] = [];
    const goUse = (s: SpotDef, held: 'none' | 'coffee' = 'none'): void => {
      steps.push({ t: 'go', tx: s.tx, ty: s.ty, fx: s.x, fy: s.y, dir: s.dir, held });
    };
    const release = (s: SpotDef) => steps.push({ t: 'do', fn: () => this.spots.release(s.id, ch.id) });
    let carry: 'none' | 'coffee' | 'water' = 'none';

    switch (what) {
      case 'coffee': {
        const s = this.spots.findFree('coffee', { near, by: ch.id, rng })!;
        if (!this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: 'use', ms: 1900, machine: s.furnitureId, icon: 'coffee' }, { t: 'act', pose: 'drink', held: 'coffee', ms: 2600 });
        release(s);
        carry = 'coffee';
        if (rng() < 0.45) {
          const seat = this.spots.findFree('cafe_seat', { by: ch.id, rng, near: { tx: s.tx, ty: s.ty } });
          if (seat && this.reserveTemp(ch, seat)) {
            steps.push(
              { t: 'go', tx: seat.tx, ty: seat.ty, held: 'coffee' },
              { t: 'enter', spot: seat.id },
              { t: 'act', pose: 'sit', held: 'coffee', ms: between(rng, 6000, 15000) },
              { t: 'exit' },
            );
            release(seat);
          }
        }
        break;
      }
      case 'water': {
        const s = this.spots.findFree('water', { near, by: ch.id, rng })!;
        if (!this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: 'use', ms: 1000 }, { t: 'act', pose: 'drink', held: 'water', ms: 2500 });
        release(s);
        carry = rng() < 0.4 ? 'water' : 'none';
        break;
      }
      case 'bathroom': {
        const s = this.spots.findFree('stall', { by: ch.id, rng })!;
        if (!this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        steps.push({ t: 'go', tx: s.tx, ty: s.ty }, { t: 'stall', spot: s.id, ms: between(rng, 5000, 12000), phase: 0 });
        release(s);
        const sink = this.spots.findFree('sink', { near: { tx: s.tx, ty: s.ty }, by: ch.id });
        if (sink && this.reserveTemp(ch, sink)) {
          goUse(sink);
          steps.push({ t: 'act', pose: 'use', ms: 2200 });
          release(sink);
        }
        break;
      }
      case 'lounge': {
        const s = this.randomFree(LOUNGE_SEATS, ch);
        if (!s || !this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        steps.push({ t: 'go', tx: s.tx, ty: s.ty }, { t: 'enter', spot: s.id });
        if (rng() < (hasTrait(persona, 'sonecas') ? 0.7 : 0.25)) steps.push({ t: 'act', pose: 'sit', ms: between(rng, 3000, 6000) }, { t: 'act', pose: 'sleep', ms: between(rng, 8000, 16000), icon: 'zzz' });
        else steps.push({ t: 'act', pose: 'sit', ms: between(rng, 9000, 22000), icon: rng() < 0.3 ? 'music' : undefined });
        steps.push({ t: 'exit' });
        release(s);
        break;
      }
      case 'pingpong':
      case 'talk':
        return this.social.tryInitiate(ch, now, false);
      case 'mirror':
        return this.social.startSolo('mirror', ch, now);
      case 'phone': {
        // sits on a beanbag/couch/bench and keeps scrolling the phone
        const s = this.randomFree(PHONE_SEATS, ch);
        if (!s || !this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        steps.push({ t: 'go', tx: s.tx, ty: s.ty }, { t: 'enter', spot: s.id }, { t: 'act', pose: 'read', held: 'phone', ms: between(rng, 8000, 18000) }, { t: 'exit' });
        release(s);
        break;
      }
      case 'window': {
        // look out the window or take a quick look at their own room's kanban board
        const board = rng() < 0.35 ? this.spots.findFree('whiteboard', { by: ch.id, filter: (p) => p.areaId === ch.roomId }) : null;
        const s = board ?? this.spots.findFree('window', { by: ch.id, rng });
        if (!s || !this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: board ? 'read' : 'stand', held: board ? 'papers' : 'none', ms: between(rng, 5000, 10000), icon: rng() < 0.3 ? 'idea' : undefined });
        release(s);
        break;
      }
      case 'shelf': {
        const s = this.spots.findFree('shelf', { by: ch.id, rng })!;
        if (!this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: 'read', held: 'book', ms: between(rng, 5000, 9000) });
        release(s);
        break;
      }
      case 'arcade': {
        const s = this.spots.findFree('arcade', { by: ch.id, rng })!;
        if (!this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: 'use', ms: between(rng, 6000, 12000), icon: rng() < 0.4 ? 'star' : undefined });
        release(s);
        break;
      }
      case 'snack': {
        // snack machine or the kitchen fridge
        const s = this.spots.findFree(rng() < 0.6 ? 'snack' : 'fridge', { by: ch.id, rng }) ?? this.spots.findFree('snack', { by: ch.id, rng });
        if (!s || !this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: 'use', ms: 1600 }, { t: 'act', pose: 'stand', ms: 900 });
        release(s);
        break;
      }
      case 'stretch': {
        const home = ch.homeSpot;
        if (!home) return false;
        steps.push({ t: 'exit' }, { t: 'act', pose: 'stretch', ms: 2600 }, { t: 'enter', spot: home });
        steps.push({ t: 'do', fn: () => (ch.nextOutingAt = this.now + idleSitMs(ch.rng, this.options().liveliness)) });
        ch.queue.push(...steps);
        return true;
      }
    }
    ch.queue.push(...steps);
    this.pushHome(ch, carry);
    void now;
    return true;
  }

  /** Goes back to the desk at the end of an outing. */
  pushHome(ch: Character, held: 'none' | 'coffee' | 'water'): void {
    const home = this.spots.get(ch.homeSpot);
    ch.queue.push({ t: 'do', fn: () => this.releaseTemp(ch) });
    if (!home) return;
    ch.queue.push({ t: 'go', tx: home.tx, ty: home.ty, held }, { t: 'enter', spot: home.id });
    ch.queue.push({ t: 'do', fn: () => (ch.nextOutingAt = this.now + idleSitMs(ch.rng, this.options().liveliness)) });
  }

  /** Rest pose when there are no steps (at the desk: typing, asking for attention, seated or napping). */
  private restPose(ch: Character, now: number): void {
    const spot = ch.atSpot ? this.spots.get(ch.atSpot) : undefined;
    const atHome = !!spot && ch.atSpot === ch.homeSpot;
    if (!spot) {
      // no place (full room): works standing with the laptop
      if (ch.mode === 'wait') ch.setPose('raise_hand');
      else if (ch.mode === 'work' && ch.standTile) ch.setPose('read', 'laptop');
      else ch.setPose('stand');
      return;
    }
    if (spot.kind === 'stand') {
      ch.dir = spot.dir;
      if (ch.mode === 'work') ch.setPose('read', 'laptop');
      else if (ch.mode === 'wait') ch.setPose('raise_hand');
      else ch.setPose('stand');
      return;
    }
    if (!spot.seated) {
      ch.setPose('stand');
      return;
    }
    ch.dir = spot.dir;
    // no desk (stool, armchair, beanbag): works on the laptop
    const laptop = spot.kind === 'stool' || spot.kind === 'nook';
    if (atHome && ch.mode === 'work') ch.setPose('type', laptop ? 'laptop' : 'none');
    else if (atHome && ch.mode === 'wait') ch.setPose('raise_hand');
    else if (atHome && ch.mode === 'shell') this.shellPose(ch, spot, now);
    else if (ch.mode === 'idle' && this.longIdle(ch, now)) ch.setPose('sleep');
    else ch.setPose('sit');
  }

  /**
   * Pose of the shell wait seated at the desk, by the escalation (sim/shell.ts): popcorn, arms crossed
   * with spins in the chair, yawns under the cobweb and, finally, the nap. No allocation (runs per frame).
   */
  private shellPose(ch: Character, spot: SpotDef, now: number): void {
    // visit: arms crossed watching the terminal, always (the escalation depends on a time that didn't come from the world)
    if (this.visit) {
      ch.setPose('wait');
      return;
    }
    const age = now - ch.shellSince;
    switch (ch.shellStage ?? shellStage(age)) {
      case 'popcorn':
        ch.setPose('wait', 'popcorn');
        return;
      case 'restless': {
        // full spin in the chair (directions in quick sequence), arms crossed
        ch.dir = spinDir(spinPhase(age, ch.info.seed), spot.dir);
        ch.setPose('wait');
        return;
      }
      case 'cobweb': {
        const yawn = yawnPhase(age, ch.info.seed);
        if (yawn >= 0) {
          // yawn: the head droops and a 🥱 slips out
          if (now > ch.chatUntil) {
            ch.chatEmoji = '🥱';
            ch.chatUntil = now + 1300;
          }
          ch.setPose('sleep');
        } else ch.setPose('wait');
        return;
      }
      case 'nap':
        ch.setPose('sleep');
        return;
    }
  }

  // =================================================================== visit

  /** Idle for a long time (naps at the desk, doesn't always accept an invite)? On a visit, never: no time came from the world. */
  longIdle(ch: Character, now: number): boolean {
    return !this.visit && isLongIdle(ch.info.status, ch.info.statusSince, now);
  }

  /** The drawn characters: the agents and, on a visit, the visitor (last). */
  *people(): IterableIterator<Character> {
    yield* this.chars.values();
    if (this.visitor && !this.visitor.gone) yield this.visitor;
  }

  /** A drawn character by id (agent or the visitor). */
  person(id: string): Character | undefined {
    return this.chars.get(id) ?? (this.visitor?.id === id ? this.visitor : undefined);
  }

  /** Visit: the visitor appears in the reception elevator and comes out into the hall (null = removes the visitor). */
  setVisitor(info: AgentInfo | null, now: number): Character | null {
    const old = this.visitor;
    if (old) for (const e of this.elevators) e.release(old.id, now);
    this.visitor = null;
    this.visitorIntent = { ...NO_INTENT };
    if (!info) return null;
    let appearance;
    try {
      appearance = { ...this.art.appearanceFromSeed(info.seed, { look: info.look, sub: false, parts: info.parts }), lanyard: VISITOR_LANYARD };
    } catch {
      return null;
    }
    const ch = new Character(info, appearance);
    const el = this.elevators[0];
    const spot = el ? this.spots.get(el.spotId) : undefined;
    if (!el || !spot) return null;
    ch.placeAtTile(spot.tx, spot.ty);
    ch.x = spot.x;
    ch.y = spot.y - 6;
    ch.dir = 'down';
    ch.alpha = 0;
    ch.inside = true;
    ch.arriving = true;
    ch.hiddenUntil = el.reserveAppear(now);
    ch.queue.push({ t: 'elevOut', elev: el.index, phase: 0 });
    this.visitor = ch;
    return ch;
  }

  /** The visitor is in the elevator (arriving or leaving): doesn't walk or leave again. */
  get visitorBusy(): boolean {
    const v = this.visitor;
    if (!v || v.gone) return true;
    return v.leaving || [v.step, ...v.queue].some((s) => s?.t === 'elevOut' || s?.t === 'elevIn');
  }

  /** Visit: the visitor walks to the tile (click; the keyboard cancels). */
  visitorWalkTo(tx: number, ty: number, run = false): boolean {
    const v = this.visitor;
    if (!v || this.visitorBusy) return false;
    v.queue.length = 0;
    v.step = null;
    v.queue.push({ t: 'go', tx, ty, run });
    return true;
  }

  /** The elevator near the visitor (within EXIT_RADIUS tiles of the front), or null: from there it leaves the building. */
  visitorElevator(): Elevator | null {
    const v = this.visitor;
    if (!v || this.visitorBusy) return null;
    const t = tileAt(v.x, v.y);
    for (const e of this.elevators) {
      const spot = this.spots.get(e.spotId);
      if (spot && Math.hypot(spot.tx - t.x, spot.ty - t.y) <= EXIT_RADIUS) return e;
    }
    return null;
  }

  /** Visit: the visitor enters the nearest elevator and vanishes; `done` when the door closes (the scene sends the `leave`). */
  visitorExit(done: () => void): boolean {
    const v = this.visitor;
    if (!v || this.visitorBusy) return false;
    const t = tileAt(v.x, v.y);
    let best: { e: Elevator; d: number; tx: number; ty: number } | null = null;
    for (const e of this.elevators) {
      const spot = this.spots.get(e.spotId);
      if (!spot) continue;
      const d = Math.hypot(spot.tx - t.x, spot.ty - t.y);
      if (!best || d < best.d) best = { e, d, tx: spot.tx, ty: spot.ty };
    }
    if (!best) return false;
    v.queue.length = 0;
    v.step = null;
    v.leaving = true;
    this.visitorIntent = { ...NO_INTENT };
    v.queue.push({ t: 'go', tx: best.tx, ty: best.ty }, { t: 'elevIn', elev: best.e.index, phase: 0 }, { t: 'do', fn: done });
    return true;
  }

  /**
   * Visit lights (see VisitLight): off, the rooms with nobody dark; discreet, the ready rooms lit. Live, nothing
   * (whoever arrives turns on, the last to leave turns off). `instant`: without the transition (entering the building).
   */
  applyVisitLight(now: number, instant = false): void {
    if (!this.visit || this.visitLight === 'live') return;
    const at = instant ? now - 10_000 : now;
    for (const room of this.rooms.values()) {
      if (!room.present || room.ghost) continue;
      if (this.visitLight === 'away') {
        if (room.lightOn && this.occupants(room) === 0 && !this.switchClaimValid(room)) room.setLight(false, at);
      } else if (!room.lightOn && room.phase === 'ready') room.setLight(true, at);
    }
  }

  /** Visit: the keyboard walks freely (with collision); otherwise, the queue's step (elevator, click path). */
  private runVisitor(v: Character, dt: number, now: number): void {
    v.animT += dt * 1000;
    if (v.icon && now >= v.iconUntil) v.icon = null;
    const intent = this.visitorIntent;
    const busy = this.visitorBusy;
    if (!busy && (intent.dx || intent.dy)) {
      // the keyboard rules: forgets the click path
      v.queue.length = 0;
      v.step = null;
      const r = stepFree(this.building.grid, { x: v.x, y: v.y, dir: v.dir }, intent, (intent.run ? RUN_SPEED : WALK_SPEED) * dt);
      v.x = r.x;
      v.y = r.y;
      v.dir = r.dir;
      const t = tileAt(v.x, v.y);
      v.tx = t.x;
      v.ty = t.y;
      v.setPose(r.moved ? (intent.run ? 'run' : 'walk') : 'stand');
      return;
    }
    if (!v.step) {
      v.step = v.queue.shift() ?? null;
      v.stepT = 0;
      v.stepStarted = false;
    }
    if (v.step) {
      const done = this.runStep(v, v.step, dt, now);
      v.stepT += dt * 1000;
      if (done) v.step = null;
      if (v.arriving && !v.step && !v.queue.length) v.arriving = false;
      return;
    }
    v.setPose('stand');
  }

  // =================================================================== hidden tab

  /** Advances everything instantly to the destinations (used when coming back from a hidden tab). */
  fastForward(now: number): void {
    this.now = now;
    for (const room of this.rooms.values()) {
      if (room.phase === 'building') room.setPhase('ready', now - 10_000);
      if (room.phase === 'dismantling') room.setPhase('gone', now);
      room.lightAt = now - 10_000;
    }
    this.updateRooms(now);
    for (const e of this.elevators) e.reset();
    this.machineUntil.clear();
    this.social.reset(now);
    for (const ch of [...this.chars.values()]) {
      for (let guard = 0; guard < 60 && !ch.gone; guard++) {
        if (!ch.step) ch.step = ch.queue.shift() ?? null;
        if (!ch.step) break;
        this.finishStep(ch, ch.step, now);
        ch.step = null;
      }
      ch.gathering = null;
      if (ch.leaving && !ch.gone) ch.gone = true;
      if (ch.gone) {
        this.spots.releaseAll(ch.id);
        this.chars.delete(ch.id);
        continue;
      }
      ch.alpha = 1;
      ch.inside = false;
      ch.arriving = false;
      ch.hiddenUntil = 0;
      ch.stepT = 0;
      if (ch.mode === 'work' || ch.mode === 'wait' || ch.mode === 'idle' || ch.mode === 'shell') {
        ch.reactUntil = 0;
        this.assignHome(ch);
        const home = this.spots.get(ch.homeSpot);
        if (home) {
          this.snapTo(ch, home);
          ch.standTile = null;
        } else {
          ch.atSpot = null;
          ch.seated = false;
          ch.sortY = null;
          this.placeOverflow(ch);
        }
        this.releaseTemp(ch);
        ch.nextOutingAt = now + idleSitMs(ch.rng, this.options().liveliness);
      }
    }
    for (const room of this.rooms.values()) {
      if (room.present && this.occupants(room) > 0) room.setLight(true, now - 10_000);
      room.switchClaim = null;
    }
    this.stallBusy.clear();
    // the visitor finishes what it was doing: reaches the hall or, leaving, enters the elevator (and the exit happens)
    const v = this.visitor;
    if (v) {
      for (let guard = 0; guard < 10; guard++) {
        if (!v.step) v.step = v.queue.shift() ?? null;
        if (!v.step) break;
        const s = v.step;
        v.step = null;
        if (s.t === 'elevIn') {
          v.inside = true;
          v.alpha = 0;
        } else this.finishStep(v, s, now);
      }
      if (!v.leaving) {
        v.alpha = 1;
        v.inside = false;
        v.arriving = false;
        v.hiddenUntil = 0;
        v.setPose('stand');
      }
    }
    if (this.visit) this.applyVisitLight(now);
  }

  private finishStep(ch: Character, s: Step, now: number): void {
    switch (s.t) {
      case 'go':
        ch.placeAtTile(s.tx, s.ty);
        if (s.fx !== undefined && s.fy !== undefined) {
          ch.x = s.fx;
          ch.y = s.fy;
        }
        if (s.dir) ch.dir = s.dir;
        break;
      case 'enter': {
        const spot = this.spots.get(s.spot);
        if (spot) this.snapTo(ch, spot);
        break;
      }
      case 'exit':
        if (ch.atSpot) {
          const spot = this.spots.get(ch.atSpot);
          if (spot) ch.placeAtTile(spot.tx, spot.ty);
        }
        ch.atSpot = null;
        ch.seated = false;
        ch.sortY = null;
        break;
      case 'switch': {
        const room = this.rooms.get(s.room);
        if (room && (!s.onlyIfLast || isLastInRoom(room.id, ch.id, this.chars.values()))) room.setLight(s.on, now - 10_000);
        break;
      }
      case 'stall': {
        const spot = this.spots.get(s.spot);
        if (spot) ch.placeAtTile(spot.tx, spot.ty);
        break;
      }
      case 'elevOut': {
        const el = this.elevators[s.elev] ?? this.elevators[0];
        const spot = this.spots.get(el.spotId);
        if (spot) ch.placeAtTile(spot.tx, spot.ty);
        break;
      }
      case 'do':
        s.fn();
        break;
      case 'remove':
      case 'elevIn':
        ch.gone = true;
        break;
      default:
        break;
    }
  }
}
