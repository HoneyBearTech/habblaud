// Habblaud World city scene: wires the stream (net/world-stream.ts: the local server's or the fake city of demo
// mode), the state, my player, the camera, the drawing, the input, the cards and the minimap. Mounted by app.ts
// when the World button opens the scene; the stream only exists with the scene on screen (opens on show, closes on
// hide).
// The light social (Phase 5: like, greetings, knocking on the door, profile, "Go to", the square and the facades) is
// in social.ts, wired by a few hooks (messages, snapshot, frame, drawing, cards and keys).
// My character only enters the street with the position the server validated (`pos` from the snapshot or the
// message): no `move` leaves from a guessed place. Away (`afk`), it stays still where it is; still on top of a
// bench, it sits.
// Visit (Phase 4): within ENTER_RADIUS tiles of a building's door, "Enter (E)" sends the `enter`; the `building` that
// arrives opens the Visit scene (world/visit/) on top, with the city stopped (no drawing, keyboard or `move`) and the
// stream open; the `pos` that comes after is the return to the street, at the door. Refusals (`notice`) become an
// on-screen notice.
// Back in the city on the same page (resume.ts): the camera and the zoom from when it closed, the earlier city on
// screen until the new snapshot, and the initial `pos` equal to the last one changes nothing (another place:
// straight there, without animating).
import * as artModule from '../../art';
import type { ArtModule } from '../../art/api';
import { TILE } from '../../art/api';
import { tr } from '../../../../shared/i18n';
import { blockAt, chunkOf, lotDoor } from '../../../../shared/world/city';
import type { WorldSceneInside } from '../../../../shared/world/api';
import type { AwaySummary } from '../../../../shared/world/protocol';
import { parseAwaySummary } from '../../../../shared/world/scene';
import type { WorldStream, WorldStreamEvent } from '../../net/world-stream';
import type { WorldOptions } from '../api';
import { Camera } from '../camera';
import { PathFinder } from '../path/astar';
import { h } from '../../ui/dom';
import { worldErrorText } from '../../ui/world/world-model';
import { CityCards } from './cards';
import { CityInput } from './input';
import { buildWalkGrid, nearestDoor, nearestWalkableTile, walkRectFor, walkable } from './layout';
import { Minimap } from './minimap';
import { noticeText, type NoticePlace } from './notice';
import { createVisitScene, type VisitScene } from '../visit';
import { LocalPlayer, MoveSender, pathPoints } from './players';
import { CityRenderer } from './scene';
import { resumePlacement, type CityResume } from './resume';
import { CitySocial } from './social';
import { CityState, type CityEffect } from './state';

const art: ArtModule = artModule;

/** Minimum city zoom: ~200 lots on a 1400 × 900 screen. */
export const CITY_MIN_ZOOM = 0.28;
/** Extra zooms below 1 (the office camera only has the integers per device pixel). */
const LOW_LEVELS = [0.375, 0.5, 0.75];
/** The background tab repeats the position every this (ms). */
const KEEPALIVE_MS = 30_000;
/**
 * "Enter (E)" within this (tiles) of the front of the door (`lotDoor(lot).front`), the same math as the world server
 * (which gives 1 tile of slack). TODO: use `ENTER_RADIUS`/`doorDistance` from shared/world/city.ts when the server
 * publishes it (the file is hashed on the server).
 */
export const ENTER_RADIUS = 2;
/** A notice within this after an `enter` is the door's answer (closed, full, far...). */
const DOOR_NOTICE_MS = 5_000;

class CityCamera extends Camera {
  override levels(): number[] {
    const set = new Set(super.levels());
    for (const z of LOW_LEVELS) if (z >= this.minZoom - 1e-6) set.add(z);
    set.add(this.minZoom);
    return [...set].sort((a, b) => a - b);
  }
}

export interface CitySceneOptions {
  canvas: HTMLCanvasElement;
  /** Where the card, the minimap, the hints and the notices go (the #ui, with the interface styles). */
  uiRoot: HTMLElement;
  /** Opens the stream (net/world-stream.ts: the local server's or the fake one). Called each time the scene appears. */
  openStream: () => WorldStream;
  /** The office options (day/night, names). */
  options: () => WorldOptions;
  /** Margin covered by the top bar (CSS px). */
  topInset: () => number;
  /** Habblaud version (the visit's office carries it in `meta.version`). */
  version?: () => string;
}

export interface CityScene {
  readonly visible: boolean;
  show(): void;
  hide(): void;
  zoomBy(factor: number): void;
  /** Camera back on the player. */
  recenter(): void;
  /** Camera stopped at a point (tiles), without following the player until they walk (screenshots, debugging). */
  lookAt(x: number, y: number, zoom?: number): void;
  /** Esc: closes the open card (true) or there was nothing to close (false). */
  escape(): boolean;
  destroy(): void;
  /** Measurement (debugging and the performance script). */
  perf(): { frames: number; drawAvgMs: number; drawP95Ms: number; drawMaxMs: number; fps: number; buildings: number; zoom: number };
  /** Resets the measurement (to measure only the steady state, without the frame that generates the sprites). */
  perfReset(): void;
  readonly camera: Camera;
  readonly state: CityState;
  /** My player (debugging and tests in the browser). */
  me(): { x: number; y: number; moving: boolean; seated: boolean } | null;
  /** Screen point (CSS px of the canvas) of a position in tiles. */
  toScreen(x: number, y: number): { x: number; y: number };
  /** Enters the building (`enter`): from the door (within ENTER_RADIUS tiles) or, mine, from anywhere. */
  enter(buildingId: string): void;
  /** "See it as others do": enters my building as soon as the city is ready. */
  visitOwn(): void;
  /** The Visit scene open now (null on the street). */
  visit(): VisitScene | null;
  /** The front of the door of a building in the city (tiles), or null (debugging and screenshots). */
  doorOf(buildingId: string): { x: number; y: number } | null;
  /** Walks to (x, y) tiles by A*, like a click on the ground (debugging and screenshots). */
  walkTo(x: number, y: number): boolean;
}

export function createCityScene(o: CitySceneOptions): CityScene {
  const camera = new CityCamera();
  camera.minZoom = CITY_MIN_ZOOM;
  camera.bounds = { x: -1e7, y: -1e7, w: 2e7, h: 2e7 };
  let state = new CityState();
  let renderer = new CityRenderer(o.canvas, art, camera, state);
  let stream: WorldStream | null = null;
  let me: LocalPlayer | null = null;
  let sender: MoveSender | null = null;
  let following = true;
  let visible = false;
  let raf = 0;
  let lastTs = 0;
  let mouse: { x: number; y: number } | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  /** The chunk I am in (on changing, the chunks outside the 3×3 leave the state). */
  let myChunk = '';
  /** Inside a building: the Visit scene (the city stays stopped underneath, with the stream open). */
  let visit: VisitScene | null = null;
  /** On hide: the camera, the zoom and where I was, for the city to come back the same (resume.ts). */
  let resume: CityResume | null = null;
  /** Reopened, character on the street: the earlier city stays on screen, stopped, until the new stream's snapshot. */
  let resuming = false;
  /** The return snapshot came without `pos`: the first `pos` decides (the same place or straight to the new one). */
  let resumeAwaitingPos = false;
  /** The stream's last "While you were away" (the stamps go to the board in my building's reception). */
  let awaySummary: AwaySummary | undefined;
  /** The last `enter` sent (the notices right after are from the door). */
  let entering: { id: string; at: number } | null = null;
  /** "See it as others do" requested before the city is ready. */
  let pendingOwn = false;
  const finder = new PathFinder(buildWalkGrid({ x: 0, y: 0, w: 4, h: 4 }).grid);
  const frameMs: number[] = [];
  const rafGaps: number[] = [];

  // ------------------------------------------------------------------ DOM: card, minimap, hints, notices

  let social: CitySocial | null = null;
  const cards = new CityCards({
    showBuilding: (id) => focusBuilding(id),
    topInset: () => o.topInset(),
    enter: (id) => enter(id),
    extras: (kind, id) => social?.cardExtras(kind, id) ?? null,
  });
  const minimap = new Minimap((tile) => {
    following = false;
    const z = camera.zoom;
    const c = camera.centerFor(tile.x * TILE, tile.y * TILE, z);
    camera.animateTo(c.x, c.y, z, Date.now(), 380);
  });
  const toast = h('div', { class: 'ui-city-toast', role: 'status', attrs: { 'aria-live': 'polite' }, hidden: true });
  const loading = h('div', { class: 'ui-city-loading', text: tr('Entering the city…') });
  const help = h(
    'div',
    { class: 'ui-city-help', attrs: { 'aria-hidden': 'true' } },
    h('span', {}, h('kbd', { text: 'WASD' }), ' ', tr('walk')),
    h('span', {}, h('kbd', { text: 'Shift' }), ' ', tr('run')),
    h('span', {}, h('kbd', { text: tr('click') }), ' ', tr('go there')),
    h('span', {}, h('kbd', { text: 'E' }), ' ', tr('enter')),
    h('span', {}, h('kbd', { text: 'Esc' }), ' ', tr('office')),
  );
  const layer = h('div', { class: 'ui-city', hidden: true }, cards.el, minimap.el, help, toast, loading);
  o.uiRoot.append(layer);
  social = new CitySocial({
    state: () => state,
    renderer: () => renderer,
    camera,
    canvas: o.canvas,
    send: (cmds) => stream?.send(cmds),
    me: () => (me ? { x: me.x, y: me.y } : null),
    cards,
    toast: (text) => showToast(text),
    active: () => visible,
    teleported: () => {
      // the teleport: the camera goes along (without crossing the city) and the chunks around update
      if (!me) return;
      following = true;
      camera.stop();
      const c = camera.centerFor(me.x * TILE, me.y * TILE - 12, camera.zoom);
      camera.x = c.x;
      camera.y = c.y;
      myChunk = '';
    },
    replay: (msg) => {
      const eff = state.apply(msg, performance.now());
      if (eff) onEffect(eff);
    },
    testFireworks: () => (stream as { celebrate?: () => void } | null)?.celebrate?.(),
  });
  layer.append(social.el);
  help.append(...social.helpItems());
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const showToast = (text: string) => {
    toast.textContent = text;
    toast.hidden = false;
    toast.classList.remove('is-in');
    void toast.offsetWidth;
    toast.classList.add('is-in');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 2600);
  };

  // ------------------------------------------------------------------ size

  const resize = () => {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const w = o.canvas.clientWidth || window.innerWidth;
    const hh = o.canvas.clientHeight || window.innerHeight;
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(hh * dpr);
    if (o.canvas.width !== pw || o.canvas.height !== ph) {
      o.canvas.width = pw;
      o.canvas.height = ph;
    }
    camera.setView(w, hh, dpr);
    camera.insets = { top: o.topInset(), right: 0, bottom: 0, left: 0 };
  };

  // ------------------------------------------------------------------ my player

  /** Puts my character on the street, at the position the server validated (without it, waits for the `pos`). */
  const placeMe = () => {
    const self = state.me;
    let p = state.startPos;
    if (!self || me || !p) return;
    state.startPos = null;
    if (!walkable(p.x, p.y)) {
      const t = nearestWalkableTile(p.x, p.y);
      if (t) p = { x: t.x + 0.5, y: t.y + 0.5 };
    }
    me = new LocalPlayer(p.x, p.y);
    sender = new MoveSender((m) => stream?.send([m]));
    following = true;
    const z = camera.zoom;
    const c = camera.centerFor(me.x * TILE, me.y * TILE - 12, z);
    camera.stop();
    camera.x = c.x;
    camera.y = c.y;
    loading.hidden = true;
  };

  /** The camera straight on me (without animating), with the current zoom. */
  const snapCamera = () => {
    if (!me) return;
    following = true;
    const c = camera.centerFor(me.x * TILE, me.y * TILE - 12, camera.zoom);
    camera.stop();
    camera.x = c.x;
    camera.y = c.y;
  };

  /** The first snapshot after reopening the scene: the `pos` equal to the last one leaves everything as it was. */
  const resumeFromSnapshot = () => {
    resuming = false;
    const pos = state.startPos;
    if (!pos) {
      // the `pos` comes later (the local server did not have it yet): it decides
      resumeAwaitingPos = true;
      return;
    }
    const how = resumePlacement(resume, pos);
    resume = null;
    if (how === 'keep') {
      // neither the character nor the camera changes
      state.startPos = null;
      sender?.reset();
      return;
    }
    // another place (or nothing saved): placeMe puts the character straight there, with the camera along and the same zoom
    me = null;
    sender = null;
  };

  /** A* path from my position to (x, y) tiles. */
  const walkTo = (x: number, y: number, run: boolean): boolean => {
    if (!me) return false;
    let goal = { x, y };
    if (!walkable(x, y)) {
      const t = nearestWalkableTile(x, y, 6);
      if (!t) return false;
      goal = { x: t.x + 0.5, y: t.y + 0.5 };
    }
    const win = buildWalkGrid(walkRectFor(me, goal));
    finder.setGrid(win.grid);
    const sx = Math.floor(me.x) - win.ox;
    const sy = Math.floor(me.y) - win.oy;
    const gx = Math.floor(goal.x) - win.ox;
    const gy = Math.floor(goal.y) - win.oy;
    const cells: number[] = [];
    if (!finder.find(sx, sy, gx, gy, cells)) return false;
    me.follow(pathPoints(cells, win.ox, win.oy, goal), run);
    following = true;
    return true;
  };

  const focusBuilding = (id: string) => {
    const b = state.buildings.get(id);
    if (!b) return;
    following = false;
    const d = lotDoor(b.lot);
    const z = Math.max(camera.zoom, 1.5);
    const c = camera.centerFor(d.front.x * TILE, d.front.y * TILE - 60, z);
    camera.animateTo(c.x, c.y, z, Date.now(), 420);
  };

  const onEffect = (eff: CityEffect) => {
    switch (eff.type) {
      case 'building':
        startVisit(eff.inside);
        break;
      case 'building.patch':
        visit?.patch(eff.msg);
        break;
      case 'pos':
        // inside a building, `pos` is the sidewalk in front of the door: back to the street
        if (visit) endVisit();
        if (me && resumeAwaitingPos) {
          // back in the city, the first `pos`: the same place changes nothing; another, character and camera straight there
          resumeAwaitingPos = false;
          const how = resumePlacement(resume, eff);
          resume = null;
          if (how !== 'keep') {
            me.correct(eff.x, eff.y);
            snapCamera();
          }
          sender?.reset();
        } else if (me) {
          me.correct(eff.x, eff.y);
          sender?.reset();
        } else {
          // the spawn (the server decides where, on the first `view`)
          state.startPos = { x: eff.x, y: eff.y };
          placeMe();
          enterOwnIfPending();
        }
        break;
      case 'afk':
        // Away: stays still where it is (walking by itself to a bench would send `move` and delay leaving the street).
        // Still on top of a bench, the scene draws it sitting, like the others.
        break;
      case 'profile':
        if (cards.kind === 'player' && cards.id === eff.player.id) {
          const rp = state.players.get(eff.player.id);
          const info = rp ? rp.info : eff.player;
          cards.showPlayer(info, info.buildingId ? state.buildings.get(info.buildingId) : undefined, null);
        }
        break;
      case 'notice': {
        const place: NoticePlace = visit ? 'inside' : entering && Date.now() - entering.at < DOOR_NOTICE_MS ? 'door' : 'street';
        if (place === 'door') entering = null;
        const text = noticeText(eff.text, place);
        if (text) showToast(text);
        break;
      }
    }
  };

  // ------------------------------------------------------------------ visit (Phase 4)

  const enter = (id: string) => {
    if (visit || !stream || !me) {
      if (!me && id === state.myBuildingId) pendingOwn = true;
      return;
    }
    entering = { id, at: Date.now() };
    stream.send([{ t: 'enter', buildingId: id }]);
  };

  /** "See it as others do" requested with the city still opening: enters once I am on the street (with the `pos`). */
  const enterOwnIfPending = () => {
    if (!pendingOwn || !me || !state.connected || !state.myBuildingId) return;
    pendingOwn = false;
    enter(state.myBuildingId);
  };

  /** The `building` arrived: the Visit scene opens (or, already inside the same building, swaps the whole interior). */
  const startVisit = (inside: WorldSceneInside) => {
    entering = null;
    if (visit && visit.id === inside.id) {
      visit.replace(inside);
      return;
    }
    if (visit) endVisit();
    const self = state.me;
    if (!self || !visible) return;
    cards.hide();
    input.clearKeys();
    cancelAnimationFrame(raf);
    o.canvas.hidden = true;
    layer.classList.add('is-visiting');
    const s = stream;
    visit = createVisitScene({
      uiRoot: o.uiRoot,
      after: o.canvas,
      inside,
      me: self,
      mine: inside.id === state.myBuildingId,
      options: () => o.options(),
      version: o.version?.() ?? '',
      topInset: () => o.topInset(),
      send: (cmds) => s?.send(cmds),
      toast: (text) => showToast(text),
      summaryStamps: () => awaySummary?.stamps ?? [],
      // no answer to the `leave`: restarts the city (the local server sends `view`, which the world takes as the return)
      stuck: () => {
        endVisit();
        stream?.send([{ t: 'view' }]);
      },
    });
  };

  /** Back on the street: the Visit scene leaves and the city draws again, with the camera on me. */
  const endVisit = () => {
    if (!visit) return;
    const v = visit;
    visit = null;
    v.destroy();
    layer.classList.remove('is-visiting');
    if (!visible) return;
    o.canvas.hidden = false;
    lastTs = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    following = true;
  };

  // ------------------------------------------------------------------ stream

  const offline = () => tr('No connection to Habblaud World right now; Habblaud tries again on its own.');

  const onStream = (ev: WorldStreamEvent) => {
    switch (ev.type) {
      case 'snapshot': {
        state.applySnapshot(ev.snapshot, performance.now());
        social?.snapshot(ev.snapshot);
        awaySummary = ev.snapshot.summary;
        if (resuming) resumeFromSnapshot();
        placeMe();
        if (me) myChunk = '';
        // a new stream in the middle of the visit stays inside; without the interior, I am on the street
        if (state.inside) startVisit(state.inside);
        else if (visit) endVisit();
        enterOwnIfPending();
        // with no connection to the world server, nothing comes down: says so instead of "Entering the city…"
        loading.textContent = state.connected ? tr('Entering the city…') : offline();
        loading.hidden = state.connected && !!me;
        return;
      }
      case 'message': {
        // inside a building, the visit answers first to the notices of the like and the stamp from there
        if (visit?.message(ev.msg)) return;
        // the social sees the message before the state (the earlier value) and answers the notices of its commands
        if (social?.message(ev.msg, performance.now())) return;
        if (ev.msg.t === 'away.summary') awaySummary = parseAwaySummary(ev.msg) ?? awaySummary;
        const eff = state.apply(ev.msg, performance.now());
        if (eff) onEffect(eff);
        return;
      }
      case 'status':
        // the SSE with the local server dropped: the browser reopens it and a new snapshot swaps everything
        if (ev.status === 'retrying') {
          loading.textContent = offline();
          loading.hidden = false;
        }
        return;
      case 'error':
        // command refused by the local server; with no connection to the world, the notice stays until the return snapshot
        if (ev.code === 'not_connected') {
          loading.textContent = offline();
          loading.hidden = false;
        } else if (ev.code !== 'no_stream') showToast(worldErrorText(ev.code, 'scene'));
        return;
    }
  };

  const openStream = () => {
    // back on the same page, character on the street: the earlier city stays on screen until the snapshot (no flicker)
    resuming = !!(resume?.me && me);
    resumeAwaitingPos = false;
    if (!resuming) {
      resume = null;
      state = new CityState();
      renderer = new CityRenderer(o.canvas, art, camera, state);
      renderer.fx = social;
      me = null;
      sender = null;
      loading.textContent = tr('Entering the city…');
      loading.hidden = false;
    }
    social?.reset();
    myChunk = '';
    cards.hide();
    const s = o.openStream();
    stream = s;
    s.on((ev) => {
      if (stream !== s) return;
      try {
        onStream(ev);
      } catch (err) {
        console.error('[city] stream event ignored', err);
      }
    });
  };

  const closeStream = () => {
    stream?.close();
    stream = null;
  };

  // ------------------------------------------------------------------ hit-test

  type Hit = { type: 'building'; id: string } | { type: 'player'; id: string } | null;

  const pick = (sx: number, sy: number): Hit => {
    const w = camera.screenToWorld(sx, sy);
    const slack = Math.max(1, 3 / camera.zoom);
    for (let i = renderer.charsDrawn.length - 1; i >= 0; i--) {
      const c = renderer.charsDrawn[i]!;
      if (!c.visible || c.me) continue;
      if (w.x >= c.bx - slack && w.x <= c.bx + c.bw + slack && w.y >= c.by - slack && w.y <= c.by + c.bh + slack) return { type: 'player', id: c.id };
    }
    let best: Hit = null;
    let bestDepth = -Infinity;
    for (const v of renderer.buildingsDrawn) {
      if (w.x < v.x || w.x > v.x + 192 || w.y < v.y || w.y > v.y + v.m.height) continue;
      if (v.depth > bestDepth) {
        bestDepth = v.depth;
        best = { type: 'building', id: v.b.id };
      }
    }
    return best;
  };

  let hovered: Hit = null;

  const onClick = (sx: number, sy: number, mods: { shift: boolean }) => {
    const hit = pick(sx, sy);
    const at = screenPoint(sx, sy);
    if (hit?.type === 'player') {
      const rp = state.players.get(hit.id);
      if (!rp) return;
      cards.showPlayer(rp.info, rp.info.buildingId ? state.buildings.get(rp.info.buildingId) : undefined, at);
      stream?.send([{ t: 'profile', playerId: hit.id }]);
      return;
    }
    if (hit?.type === 'building') {
      const b = state.buildings.get(hit.id);
      if (!b) return;
      cards.showBuilding(b, state.myBuildingId, at, true);
      const d = lotDoor(b.lot).front;
      walkTo(d.x, d.y + (lotDoor(b.lot).side === 's' ? 0.3 : -0.3), mods.shift);
      return;
    }
    cards.hide();
    const w = camera.screenToWorld(sx, sy);
    walkTo(w.x / TILE, w.y / TILE, mods.shift);
  };

  const screenPoint = (sx: number, sy: number) => {
    const r = o.canvas.getBoundingClientRect();
    return { x: r.left + sx, y: r.top + sy };
  };

  const updateHover = () => {
    if (!mouse) {
      if (hovered && cards.kind === 'building' && !cards.pinned) cards.hide();
      hovered = null;
      o.canvas.style.cursor = '';
      return;
    }
    const hit = pick(mouse.x, mouse.y);
    hovered = hit;
    o.canvas.style.cursor = hit ? 'pointer' : 'crosshair';
    if (hit?.type === 'building') {
      const b = state.buildings.get(hit.id);
      if (b && (!cards.pinned || cards.id === b.id)) cards.showBuilding(b, state.myBuildingId, screenPoint(mouse.x, mouse.y), false);
    } else if (cards.kind === 'building' && !cards.pinned) cards.hide();
  };

  const input = new CityInput(o.canvas, camera, {
    // inside a building, the keyboard belongs to the Visit scene
    active: () => visible && !visit,
    hover: (sx, sy, inside) => {
      mouse = inside ? { x: sx, y: sy } : null;
    },
    click: onClick,
    interact: () => {
      following = false;
      camera.stop();
    },
    zoomStep: (steps, sx = camera.viewW / 2, sy = camera.viewH / 2) => camera.zoomAt(camera.stepZoom(steps), sx, sy, Date.now(), true),
    use: () => {
      if (!me) return;
      const d = nearestDoor(me.x, me.y, (lot) => !!state.buildingAt(lot), ENTER_RADIUS);
      const b = d ? state.buildingAt(d.lot) : undefined;
      if (!b) {
        showToast(tr("Get close to a building's door and press E."));
        return;
      }
      enter(b.id);
    },
    recenter: () => recenter(),
    moved: () => {
      following = true;
    },
  });

  const recenter = () => {
    if (visit) return visit.world.overview();
    following = true;
    if (!me) return;
    const c = camera.centerFor(me.x * TILE, me.y * TILE - 12, camera.zoom);
    camera.animateTo(c.x, c.y, camera.zoom, Date.now(), 360);
  };

  // ------------------------------------------------------------------ loop

  const loop = (ts: number) => {
    raf = requestAnimationFrame(loop);
    const gap = lastTs ? ts - lastTs : 16.7;
    const dt = lastTs ? Math.min(0.1, Math.max(0, gap / 1000)) : 1 / 60;
    lastTs = ts;
    rafGaps.push(gap);
    if (rafGaps.length > 240) rafGaps.shift();
    const now = performance.now();
    try {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      if (o.canvas.clientWidth !== camera.viewW || o.canvas.clientHeight !== camera.viewH || dpr !== camera.dpr) resize();
      const self = state.me;
      if (me && self && !resuming) {
        me.update(dt, input.intent());
        sender?.tick(now, me);
        // the server does not say when it stops subscribing: on changing chunk, the buildings outside the 3×3 leave
        const c = chunkOf(blockAt(me.x, me.y));
        const key = `${c.x},${c.y}`;
        if (key !== myChunk) {
          myChunk = key;
          state.keepAround(me.x, me.y);
        }
      }
      social?.frame(now, dt);
      const target = following && me ? camera.centerFor(me.x * TILE, me.y * TILE - 12, camera.zoom) : null;
      camera.update(Date.now(), target, dt);
      const door = me ? nearestDoor(me.x, me.y, (lot) => !!state.buildingAt(lot), ENTER_RADIUS) : null;
      renderer.frame(now, dt, o.options(), me && self ? { player: me, self } : null, {
        building: hovered?.type === 'building' ? hovered.id : cards.kind === 'building' ? cards.id : null,
        player: hovered?.type === 'player' ? hovered.id : cards.kind === 'player' ? cards.id : null,
        door: door ? door.front : null,
        me: me ? { x: me.x, y: me.y } : null,
      });
      frameMs.push(renderer.lastFrameMs);
      if (frameMs.length > 240) frameMs.shift();
      updateHover();
      // the building's card follows changes (likes, state); it goes away if the building is gone
      if (cards.kind === 'building' && cards.id && !state.buildings.has(cards.id)) cards.hide();
      if (cards.kind === 'player' && cards.id && !state.players.has(cards.id)) cards.hide();
      if (me) {
        const tl = camera.screenToWorld(0, 0);
        const br = camera.screenToWorld(camera.viewW, camera.viewH);
        minimap.draw(state.minimap, state.minimapVersion, me, { x: tl.x / TILE, y: tl.y / TILE, w: (br.x - tl.x) / TILE, h: (br.y - tl.y) / TILE });
      }
    } catch (err) {
      console.error('[city] error in frame', err);
    }
  };

  const onVisibility = () => {
    lastTs = 0;
    input.clearKeys();
    // back on the tab: the next tick resends the position, even if something got stuck while it was hidden
    if (!document.hidden) sender?.reset();
  };

  // ------------------------------------------------------------------ API

  const scene: CityScene = {
    get visible() {
      return visible;
    },
    show() {
      if (visible) return;
      visible = true;
      o.canvas.hidden = false;
      layer.hidden = false;
      resize();
      if (resume) {
        // the camera and the zoom from when the scene closed (resume.ts)
        camera.stop();
        camera.zoom = resume.zoom;
        camera.x = resume.camX;
        camera.y = resume.camY;
        following = resume.following;
      } else if (!camera.animating) camera.zoom = camera.viewW < 600 ? 1.5 : 2;
      openStream();
      lastTs = 0;
      raf = requestAnimationFrame(loop);
      window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', onVisibility);
      keepAlive = setInterval(() => {
        // inside a building, no step goes out (in there the server ignores it and the time does not count toward afk)
        if (document.hidden && me && sender && !visit) sender.keepAlive(me);
      }, KEEPALIVE_MS);
    },
    hide() {
      if (!visible) return;
      // the city closed: the visit goes with it (the stream closes and the local server sends `view.off`)
      if (visit) endVisit();
      pendingOwn = false;
      // to come back the same: the camera, the zoom and where I was
      resume = { camX: camera.x, camY: camera.y, zoom: camera.zoom, following, me: me ? { x: me.x, y: me.y } : null };
      visible = false;
      cancelAnimationFrame(raf);
      o.canvas.hidden = true;
      layer.hidden = true;
      cards.hide();
      social?.hide();
      input.clearKeys();
      closeStream();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = null;
    },
    zoomBy(factor) {
      if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
      if (visit) return visit.world.zoomBy(factor);
      camera.zoomAt(camera.stepZoom(factor > 1 ? 1 : -1), camera.viewW / 2, camera.viewH / 2, Date.now(), true);
    },
    recenter,
    lookAt(x, y, zoom = camera.zoom) {
      following = false;
      camera.stop();
      camera.zoom = Math.max(CITY_MIN_ZOOM, Math.min(6, zoom));
      const c = camera.centerFor(x * TILE, y * TILE, camera.zoom);
      camera.x = c.x;
      camera.y = c.y;
    },
    escape() {
      // inside a building, Esc belongs to the visit (closes the card or leaves)
      if (visit) return visit.escape();
      if (social?.escape()) return true;
      if (cards.open) {
        cards.hide();
        return true;
      }
      return false;
    },
    destroy() {
      scene.hide();
      input.destroy();
      social?.destroy();
      layer.remove();
    },
    perf() {
      const sorted = [...frameMs].sort((a, b) => a - b);
      const avg = frameMs.reduce((s, v) => s + v, 0) / Math.max(1, frameMs.length);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      const gapAvg = rafGaps.reduce((s, v) => s + v, 0) / Math.max(1, rafGaps.length);
      return { frames: frameMs.length, drawAvgMs: avg, drawP95Ms: p95, drawMaxMs: sorted[sorted.length - 1] ?? 0, fps: gapAvg ? 1000 / gapAvg : 0, buildings: renderer.buildingsDrawn.length, zoom: camera.zoom };
    },
    camera,
    get state() {
      return state;
    },
    perfReset() {
      frameMs.length = 0;
      rafGaps.length = 0;
    },
    me: () => (me ? { x: me.x, y: me.y, moving: me.moving, seated: !me.moving && renderer.onBench(me.x, me.y) } : null),
    toScreen: (x, y) => camera.worldToScreen(x * TILE, y * TILE),
    enter: (id) => enter(id),
    visitOwn() {
      const id = state.myBuildingId;
      if (me && stream && id && state.connected) enter(id);
      else pendingOwn = true;
    },
    visit: () => visit,
    walkTo: (x, y) => walkTo(x, y, false),
    doorOf(id) {
      const b = state.buildings.get(id);
      return b ? { ...lotDoor(b.lot).front } : null;
    },
  };
  return scene;
}
