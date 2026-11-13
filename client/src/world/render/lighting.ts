// Lighting of the day/night cycle: a cached light map (exterior darkened and bluish, interiors
// lit, halos of lampposts and light fixtures) multiplied over the scene, and the per-frame glows (monitors,
// TV, machines, car headlights, fireflies). The colors come from daylight.ts (pure).
//
// Cost: by day nothing is drawn. Other than that, the map (half the world's resolution) is only rebuilt when
// the light key changes (time in steps of a few seconds, room lights, occupancy of the common areas,
// room assembly); per frame, one drawImage in 'multiply' and a few cached glow sprites.
import { TILE, type ArtModule, type ScreenMode } from '../../art/api';
import { mulberry32 } from '../../../../shared/hash';
import { BUILDING_H, COL_W, CORRIDOR_H, CORRIDOR_Y } from '../constants';
import type { ExteriorLayout, SlotShell } from '../layout/exterior';
import type { RoomState } from '../sim/room-state';
import type { Sim } from '../sim/sim';
import { buildAnim } from './anim';
import { ambientAt, ambientDistance, approachAmbient, effectiveHour, isNeutral, mixRgb, rgbCss, sunbeamAt, WHITE, type Ambient, type DaylightMode, type Rgb } from './daylight';
import { glowSprite } from './props';
import { furnitureSprites, wallItemOrigin, wallSprites, type AreaVis, type FurnVis, type WallVis } from './scene';

/** The light level is recalculated at most this often (ms). */
export const RECALC_MS = 4_000;
/** World pixels per light map pixel. */
const MAP_SCALE = 2;
/** Duration (ms) of the transition when the preference or the forced time changes. */
const FADE_MS = 1_200;
/** Occupancy of the common areas (light by presence) reevaluated this often (ms). */
const OCCUPANCY_MS = 250;
const LAMP_WARM: Rgb = [255, 236, 196];
const STREET_WARM: Rgb = [255, 214, 150];
const SCREEN_COOL: Rgb = [196, 222, 255];
const ARCADE_GLOW: Rgb = [236, 190, 255];
const FIREFLIES = 26;

/** What the lighting needs from the renderer (satisfied by the Renderer itself). */
export interface LightScene {
  readonly areas: ReadonlyMap<string, AreaVis>;
  readonly exterior: ExteriorLayout;
  readonly shells: readonly SlotShell[];
  readonly shellWindows: readonly WallVis[];
  readonly cars: readonly { x: number; y: number; dir: 1 | -1 }[];
  roomInSlot(slot: number): RoomState | undefined;
  deskScreen(f: FurnVis, area: AreaVis): ScreenMode;
}

/** Visible rectangle (world px). */
export interface View {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Firefly {
  x: number;
  y: number;
  ph: number;
  sx: number;
  sy: number;
  blink: number;
}

const halos = new Map<string, HTMLCanvasElement>();

/**
 * Halo for the light map: radial gradient from the color `c` (opaque at the center) to transparent. Drawn
 * with 'lighten', it brightens the map up to the lamp's color without ever darkening what is already lit.
 */
function haloSprite(c: Rgb, size: number): HTMLCanvasElement {
  const key = `${c.join(',')}:${size}`;
  let s = halos.get(key);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = size;
  s.height = size;
  const ctx = s.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const [r, gg, b] = c;
  g.addColorStop(0, `rgba(${r},${gg},${b},1)`);
  g.addColorStop(0.35, `rgba(${r},${gg},${b},0.8)`);
  g.addColorStop(0.7, `rgba(${r},${gg},${b},0.3)`);
  g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  halos.set(key, s);
  return s;
}

let vignette: HTMLCanvasElement | null = null;

/** Vignette (multiply) of the lit rooms at night: neutral center, corners a little darker and warmer. */
function vignetteSprite(): HTMLCanvasElement {
  if (vignette) return vignette;
  const size = 64;
  vignette = document.createElement('canvas');
  vignette.width = size;
  vignette.height = size;
  const ctx = vignette.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size * 0.45, 0, size / 2, size * 0.45, size * 0.62);
  g.addColorStop(0, 'rgb(255,255,255)');
  g.addColorStop(0.5, 'rgb(252,248,242)');
  g.addColorStop(1, 'rgb(212,196,176)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return vignette;
}

const beams = new Map<string, HTMLCanvasElement>();

/** Strip of sunlight (vertical gradient: strong next to the window, fades out at the end). */
function beamSprite(c: Rgb): HTMLCanvasElement {
  const key = c.join(',');
  let s = beams.get(key);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = 8;
  s.height = 64;
  const ctx = s.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0.9)`);
  g.addColorStop(0.55, `rgba(${c[0]},${c[1]},${c[2]},0.55)`);
  g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 64);
  // soft side edges
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, 1, 64);
  ctx.fillRect(7, 0, 1, 64);
  beams.set(key, s);
  return s;
}

const prefersReducedMotion = (): boolean => {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

export class Lighting {
  /** Applied ambient (may be in transition to `target`). */
  ambient: Ambient = ambientAt(12);
  private target: Ambient = this.ambient;
  private calcAt = -1e9;
  private lastNow = 0;
  private mode: DaylightMode | null = null;
  private override: number | null = null;
  private map: HTMLCanvasElement | null = null;
  private mapCtx: CanvasRenderingContext2D | null = null;
  private mapKey = '';
  private mapX = 0;
  private mapY = 0;
  /** Light by presence of the common areas (0 = dim light, 1 = lit), with transition. */
  private coreLevel = new Map<string, number>();
  private coreBusy = new Map<string, boolean>();
  private occAt = 0;
  private flies: Firefly[] = [];
  private fliesFor: ExteriorLayout | null = null;
  private reduced = prefersReducedMotion();
  private reducedAt = 0;

  constructor(
    private readonly art: ArtModule,
    private readonly sim: Sim,
  ) {}

  /**
   * Updates the ambient (recalculates the light at most every RECALC_MS, or right away when the preference
   * or the forced time changes) and returns the effective time, for the sky in the windows.
   */
  update(now: number, mode: DaylightMode, override: number | null, date: Date): number {
    const hour = effectiveHour(mode, override, date);
    const changed = mode !== this.mode || override !== this.override;
    if (now - this.reducedAt > 5_000) {
      this.reducedAt = now;
      this.reduced = prefersReducedMotion();
    }
    if (changed || now - this.calcAt >= RECALC_MS) {
      const first = this.mode === null;
      this.mode = mode;
      this.override = override;
      this.calcAt = now;
      this.target = ambientAt(hour);
      if (first || this.reduced) this.ambient = this.target;
    }
    const dt = Math.max(0, Math.min(250, now - this.lastNow));
    this.lastNow = now;
    if (this.ambient !== this.target) {
      // smooth transition (with reduced motion, switches directly)
      this.ambient = this.reduced ? this.target : approachAmbient(this.ambient, this.target, (dt / FADE_MS) * 3);
      if (ambientDistance(this.ambient, this.target) < 3) this.ambient = this.target;
    }
    return hour;
  }

  get night(): number {
    return this.ambient.night;
  }

  // =================================================================== light map

  /** Multiplies the light map over what is visible (nothing by day). */
  drawAmbient(ctx: CanvasRenderingContext2D, scene: LightScene, view: View, now: number, dt: number): void {
    const amb = this.ambient;
    this.updateOccupancy(scene, now, dt);
    if (isNeutral(amb)) return;
    const map = this.ensureMap(scene, now);
    if (!map) return;
    const mx0 = this.mapX;
    const my0 = this.mapY;
    const mx1 = mx0 + map.width * MAP_SCALE;
    const my1 = my0 + map.height * MAP_SCALE;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    // visible part of the map (in whole map pixels)
    const sx = Math.max(0, Math.floor((view.x0 - mx0) / MAP_SCALE) - 1);
    const sy = Math.max(0, Math.floor((view.y0 - my0) / MAP_SCALE) - 1);
    const ex = Math.min(map.width, Math.ceil((view.x1 - mx0) / MAP_SCALE) + 1);
    const ey = Math.min(map.height, Math.ceil((view.y1 - my0) / MAP_SCALE) + 1);
    // no smoothing: sharp pixels like the rest of the art (and much cheaper to scale up)
    if (ex > sx && ey > sy) ctx.drawImage(map, sx, sy, ex - sx, ey - sy, mx0 + sx * MAP_SCALE, my0 + sy * MAP_SCALE, (ex - sx) * MAP_SCALE, (ey - sy) * MAP_SCALE);
    // beyond the map: the same tone as the exterior
    ctx.fillStyle = rgbCss(amb.outside);
    const w = view.x1 - view.x0 + 4;
    if (view.y0 < my0) ctx.fillRect(view.x0 - 2, view.y0 - 2, w, my0 - view.y0 + 2);
    if (view.y1 > my1) ctx.fillRect(view.x0 - 2, my1, w, view.y1 - my1 + 2);
    const top = Math.max(view.y0 - 2, my0);
    const bottom = Math.min(view.y1 + 2, my1);
    if (bottom > top) {
      if (view.x0 < mx0) ctx.fillRect(view.x0 - 2, top, mx0 - view.x0 + 2, bottom - top);
      if (view.x1 > mx1) ctx.fillRect(mx1, top, view.x1 - mx1 + 2, bottom - top);
    }
    ctx.restore();
  }

  /** Common areas light up with people inside (bathroom with a presence sensor, kitchen, lounge). */
  private updateOccupancy(scene: LightScene, now: number, dt: number): void {
    if (now - this.occAt >= OCCUPANCY_MS) {
      this.occAt = now;
      for (const vis of scene.areas.values()) {
        if (vis.room || !this.presenceLit(vis)) continue;
        this.coreBusy.set(vis.id, this.someoneIn(vis.layout.rect));
      }
    }
    const k = this.reduced ? 1 : Math.min(1, dt * 3.5);
    for (const [id, busy] of this.coreBusy) {
      const cur = this.coreLevel.get(id) ?? (busy ? 1 : 0);
      const want = busy ? 1 : 0;
      this.coreLevel.set(id, Math.abs(want - cur) < 0.02 ? want : cur + (want - cur) * k);
    }
  }

  /** Kitchen, lounge and bathrooms: light by presence. Reception and corridor always stay lit. */
  private presenceLit(vis: AreaVis): boolean {
    const kind = vis.layout.kind;
    return kind === 'cafe' || kind === 'lounge' || kind === 'restroom';
  }

  private someoneIn(r: { x: number; y: number; w: number; h: number }): boolean {
    for (const c of this.sim.chars.values()) {
      if (c.gone || c.inside) continue;
      if (c.tx >= r.x && c.ty >= r.y && c.tx < r.x + r.w && c.ty < r.y + r.h) return true;
    }
    return false;
  }

  /** Light (0..1) and coverage (assembly/disassembly) of an area. */
  private areaLight(vis: AreaVis, now: number): { lit: number; cover: number } {
    const room = vis.room;
    if (room) {
      const cover = room.phase === 'building' || room.phase === 'dismantling' ? buildAnim(room.phase, room.progress(now)).floor : 1;
      return { lit: room.light(now), cover };
    }
    if (this.presenceLit(vis)) return { lit: this.coreLevel.get(vis.id) ?? 0, cover: 1 };
    return { lit: 1, cover: 1 };
  }

  /** Multiply color of an area on the map. */
  private areaColor(vis: AreaVis, lit: number, cover: number): Rgb {
    const amb = this.ambient;
    let c: Rgb;
    if (vis.room) {
      // a room with the light off stays neutral on the map: its darkening is the room's shadow (renderer)
      c = mixRgb(WHITE, amb.inside, lit);
    } else if (vis.layout.kind === 'corridor') {
      c = mixRgb(amb.inside, amb.dim, 0.18);
    } else {
      c = mixRgb(amb.dim, amb.inside, lit);
    }
    return cover >= 1 ? c : mixRgb(amb.outside, c, cover);
  }

  private ensureMap(scene: LightScene, now: number): HTMLCanvasElement | null {
    const b = scene.exterior.bounds;
    const w = Math.ceil((b.w * TILE) / MAP_SCALE);
    const h = Math.ceil((b.h * TILE) / MAP_SCALE);
    if (!this.map || this.map.width !== w || this.map.height !== h) {
      try {
        this.map = document.createElement('canvas');
        this.map.width = w;
        this.map.height = h;
        this.mapCtx = this.map.getContext('2d');
      } catch {
        this.map = null;
        this.mapCtx = null;
      }
      this.mapKey = '';
    }
    if (!this.map || !this.mapCtx) return null;
    this.mapX = b.x * TILE;
    this.mapY = b.y * TILE;
    const key = this.lightKey(scene, now);
    if (key !== this.mapKey) {
      this.mapKey = key;
      this.paintMap(this.mapCtx, scene, now);
    }
    return this.map;
  }

  /** Everything that changes the map, in discrete steps (avoids rebuilding it every frame). */
  private lightKey(scene: LightScene, now: number): string {
    const a = this.ambient;
    let k = `${Math.round(a.night * 200)}|${a.outside.join(',')}|${a.inside.join(',')}|${a.dim.join(',')}|${this.sim.building.cols}`;
    for (const vis of scene.areas.values()) {
      const { lit, cover } = this.areaLight(vis, now);
      k += `|${vis.id}:${Math.round(lit * 24)}:${Math.round(cover * 20)}`;
    }
    for (const sh of scene.shells) if (scene.roomInSlot(sh.slot)) k += `|s${sh.slot}`;
    return k;
  }

  private paintMap(m: CanvasRenderingContext2D, scene: LightScene, now: number): void {
    const amb = this.ambient;
    const n = amb.night;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.globalAlpha = 1;
    m.fillStyle = rgbCss(amb.outside);
    m.fillRect(0, 0, this.map!.width, this.map!.height);
    // from here on, world coordinates
    m.setTransform(1 / MAP_SCALE, 0, 0, 1 / MAP_SCALE, -this.mapX / MAP_SCALE, -this.mapY / MAP_SCALE);
    const corridorLit = rgbCss(mixRgb(amb.inside, amb.dim, 0.18));
    // corridor closures in the empty slots (facade with windows to the north, low wall to the south)
    for (const sh of scene.shells) {
      if (scene.roomInSlot(sh.slot)) continue;
      const r = sh.rect;
      m.fillStyle = corridorLit;
      if (r.y === 0) m.fillRect(r.x * TILE, (r.y + r.h - 2) * TILE, r.w * TILE, 2 * TILE);
      else m.fillRect(r.x * TILE, r.y * TILE, r.w * TILE, TILE);
    }
    const lit = new Map<AreaVis, number>();
    for (const vis of scene.areas.values()) {
      const l = this.areaLight(vis, now);
      if (l.cover <= 0.01) continue;
      // how much light the area "radiates" (windows): rooms by their light, empty common areas in dim light
      lit.set(vis, vis.room ? l.lit * l.cover : this.presenceLit(vis) ? 0.4 + 0.6 * l.lit : 1);
      const p = vis.px;
      const shade = vis.room ? vis.layout.shade : undefined;
      if (shade && l.cover >= 1) {
        // the low wall of the north rooms (outside the shadow) gets the corridor's light
        m.fillStyle = corridorLit;
        m.fillRect(p.x, p.y, p.w, p.h);
        m.fillStyle = rgbCss(this.areaColor(vis, l.lit, l.cover));
        m.fillRect(shade.x, shade.y, shade.w, shade.h);
      } else {
        m.fillStyle = rgbCss(this.areaColor(vis, l.lit, l.cover));
        m.fillRect(p.x, p.y, p.w, p.h);
      }
      // at night, the center of the lit rooms is brighter than the corners (ceiling light)
      const glow = (vis.room ? l.lit : this.presenceLit(vis) ? l.lit : vis.layout.kind === 'corridor' ? 0 : 1) * l.cover * n;
      if (glow > 0.05) {
        const r = shade ?? p;
        m.globalCompositeOperation = 'multiply';
        m.globalAlpha = Math.min(1, glow);
        m.drawImage(vignetteSprite(), r.x, r.y, r.w, r.h);
        m.globalAlpha = 1;
        m.globalCompositeOperation = 'source-over';
      }
    }
    if (n < 0.12) {
      m.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    // halos: lit light fixtures, machines, lampposts, the light from the windows on the lawn
    m.globalCompositeOperation = 'lighten';
    const lamp = haloSprite(LAMP_WARM, 64);
    const street = haloSprite(STREET_WARM, 64);
    const cool = haloSprite(SCREEN_COOL, 48);
    const arcade = haloSprite(ARCADE_GLOW, 48);
    const k = Math.min(1, (n - 0.12) / 0.5);
    const halo = (img: HTMLCanvasElement, cx: number, cy: number, w: number, h: number, a: number) => {
      if (a <= 0.01) return;
      m.globalAlpha = Math.min(1, a);
      m.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    };
    for (const [vis, l] of lit) {
      // in the rooms, only with the light on; in the common areas, lamps and machines always stay on
      // (night-watch light when nobody is there)
      const on = vis.room ? vis.room.lightOn && l >= 0.3 : true;
      if (!on) continue;
      const a = vis.room ? k * l : k;
      for (const f of vis.furniture) {
        if (f.kind === 'floor_lamp') halo(lamp, f.ax, f.ay - 6, 92, 66, a);
        else if (f.kind === 'vending_machine') halo(cool, f.ax, f.ay + 4, 52, 34, 0.9 * a);
        else if (f.kind === 'arcade') halo(arcade, f.ax, f.ay + 4, 44, 30, 0.8 * a);
      }
    }
    for (const prop of scene.exterior.props) {
      if (prop.kind === 'lamp') {
        halo(street, prop.x, prop.y + 6, 120, 84, k);
        halo(street, prop.x, prop.y - 30, 30, 24, 0.7 * k);
      } else if (prop.kind === 'totem') halo(cool, prop.x, prop.y - 4, 34, 22, 0.6 * k);
    }
    this.paintWindowSpill(scene, lit, k, halo, street);
    m.globalAlpha = 1;
    m.globalCompositeOperation = 'source-over';
    m.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** At night, the light from the windows and the glass facades is cast onto the lawn and the sidewalk. */
  private paintWindowSpill(
    scene: LightScene,
    lit: Map<AreaVis, number>,
    k: number,
    halo: (img: HTMLCanvasElement, cx: number, cy: number, w: number, h: number, a: number) => void,
    warm: HTMLCanvasElement,
  ): void {
    const bw = this.sim.building.cols * COL_W * TILE;
    const bh = BUILDING_H * TILE;
    for (const [vis, l] of lit) {
      if (l < 0.3) continue;
      const r = vis.layout.rect;
      if (r.y === 0) {
        // north wall windows -> lawn north of the building
        for (const w of vis.wallItems) if (w.kind === 'window') halo(warm, w.cx, -12, 58, 30, 0.55 * k * l);
      } else if (vis.layout.kind !== 'corridor' && r.y + r.h >= BUILDING_H) {
        // south rooms: soft glow over the hedge and the sidewalk
        for (const fx of [0.25, 0.75]) halo(warm, (r.x + r.w * fx) * TILE, bh + 16, 96, 30, 0.35 * k * l);
      }
    }
    // glass facades of the corridor (entrance on the west and east end)
    const cy = (CORRIDOR_Y + CORRIDOR_H / 2) * TILE;
    halo(warm, -20, cy, 56, 92, 0.6 * k);
    halo(warm, bw + 20, cy, 56, 92, 0.45 * k);
    // corridor windows that face the courtyards of the empty slots
    for (const w of scene.shellWindows) {
      const slot = Number(w.areaId.slice(6));
      if (scene.roomInSlot(slot)) continue;
      halo(warm, w.cx, w.baseY - 2 * TILE - 14, 52, 28, 0.5 * k);
    }
  }

  // =================================================================== per-frame glows

  /** Additive glows: monitors, TV, machines, lamppost bulbs, headlights and fireflies. */
  drawGlows(ctx: CanvasRenderingContext2D, scene: LightScene, view: View, now: number): void {
    const n = this.ambient.night;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const cool = glowSprite('#7fb8ff', 48);
    const warm = glowSprite('#ffcf7a', 64);
    const inView = (x: number, y: number, m: number) => x > view.x0 - m && x < view.x1 + m && y > view.y0 - m && y < view.y1 + m;
    for (const vis of scene.areas.values()) {
      const p = vis.px;
      if (p.x > view.x1 + 40 || p.x + p.w < view.x0 - 40 || p.y > view.y1 + 40 || p.y + p.h < view.y0 - 40) continue;
      const room = vis.room;
      const dark = room ? 1 - room.light(now) : 0;
      const k = Math.max(n, dark);
      if (k < 0.2) continue;
      for (const f of vis.furniture) {
        if (!inView(f.ax, f.ay, 40)) continue;
        if (f.kind === 'desk' || f.kind === 'desk_back') {
          const mode = scene.deskScreen(f, vis);
          if (mode === 'off') continue;
          // whoever works at night has their face lit by the screen
          ctx.globalAlpha = (mode === 'idle' ? 0.2 : 0.35) * k;
          ctx.drawImage(cool, Math.round(f.ax - 24), Math.round(f.ay - 34));
        } else if (f.kind === 'floor_lamp' && n > 0.2 && (!room || room.lightOn)) {
          // lit bulb (the halo on the ground is in the light map)
          const g = this.lampHead(f);
          ctx.globalAlpha = 0.5 * n;
          ctx.drawImage(warm, Math.round(g.x - 16), Math.round(g.y - 16), 32, 32);
        } else if (f.kind === 'vending_machine' || f.kind === 'arcade') {
          ctx.globalAlpha = 0.25 * k;
          ctx.drawImage(cool, Math.round(f.ax - 24), Math.round(f.ay - 36));
        }
      }
      // wall TV turned on: bluish light in front of the screen
      if (n > 0.2) {
        for (const w of vis.wallItems) {
          if (w.kind !== 'tv' || !inView(w.cx, w.baseY, 60)) continue;
          ctx.globalAlpha = 0.3 * n;
          ctx.drawImage(cool, Math.round(w.cx - 28), Math.round(w.baseY - 30), 56, 56);
        }
      }
    }
    this.drawSunbeams(ctx, scene, view);
    if (n > 0.2) {
      for (const prop of scene.exterior.props) {
        if (prop.kind !== 'lamp' || !inView(prop.x, prop.y, 64)) continue;
        ctx.globalAlpha = 0.6 * n;
        ctx.drawImage(warm, Math.round(prop.x - 14), Math.round(prop.y - 43), 28, 28);
      }
      this.drawHeadlights(ctx, scene, view, n);
      if (n > 0.6 && !this.reduced) this.drawFireflies(ctx, scene, view, now, (n - 0.6) / 0.4);
    }
    ctx.restore();
  }

  /**
   * Sun coming in through the north wall windows (the sun in Brazil passes to the north): strips of light on
   * the floor, short at noon and long and orange in the early morning and in the late afternoon; in the morning
   * they lean west, in the afternoon east.
   */
  private drawSunbeams(ctx: CanvasRenderingContext2D, scene: LightScene, view: View): void {
    const sun = sunbeamAt(this.ambient.hour);
    if (!sun) return;
    const img = beamSprite(mixRgb([255, 226, 160], [255, 150, 64], this.ambient.warm));
    ctx.globalCompositeOperation = 'lighter';
    /** Strips of the windows `ws`, clipped to the floor `clip` (light does not go through walls). */
    const draw = (ws: readonly WallVis[], clip: { x: number; y: number; w: number; h: number }) => {
      if (clip.x > view.x1 || clip.x + clip.w < view.x0 || clip.y > view.y1 || clip.y + clip.h < view.y0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, clip.w, clip.h);
      ctx.clip();
      ctx.globalAlpha = sun.alpha;
      for (const w of ws) {
        const r = this.windowGlass(w);
        if (!r) continue;
        // parallelogram: starts at the base of the wall and slides in x as it goes down
        ctx.save();
        ctx.transform(1, 0, sun.skew, 1, r.x - sun.skew * w.baseY, 0);
        ctx.drawImage(img, 0, w.baseY, r.w, sun.len);
        ctx.restore();
      }
      ctx.restore();
    };
    for (const vis of scene.areas.values()) {
      if (vis.layout.rect.y !== 0) continue;
      if (vis.room && vis.room.phase !== 'ready') continue;
      const ws = vis.wallItems.filter((w) => w.kind === 'window');
      if (!ws.length) continue;
      const p = vis.px;
      draw(ws, { x: p.x, y: p.y + 2 * TILE, w: p.w, h: p.h - 3 * TILE });
    }
    for (const sh of scene.shells) {
      if (sh.rect.y !== 0 || scene.roomInSlot(sh.slot)) continue;
      const ws = scene.shellWindows.filter((w) => w.areaId === `shell:${sh.slot}`);
      draw(ws, { x: sh.rect.x * TILE, y: CORRIDOR_Y * TILE, w: sh.rect.w * TILE, h: CORRIDOR_H * TILE });
    }
  }

  /** Rectangle of a window's glass (world px, only x and width matter). */
  private windowGlass(w: WallVis): { x: number; w: number } | null {
    const s = wallSprites(this.art, 'window', w.variant, 0, w.seed);
    if (!s) return null;
    const o = wallItemOrigin(w, s.base);
    const g = s.base.rects?.glass;
    return g ? { x: o.x + g.x, w: g.w } : { x: o.x + 3, w: s.base.canvas.width - 6 };
  }

  /** Center of the light fixture's bulb (rects.glow from the art, or a guess by the height). */
  private lampHead(f: FurnVis): { x: number; y: number } {
    const s = furnitureSprites(this.art, f)?.base;
    const r = s?.rects?.glow;
    if (s && r) return { x: f.ax - s.ax + r.x + r.w / 2, y: f.ay - s.ay + r.y + r.h / 2 };
    return { x: f.ax, y: f.ay - 33 };
  }

  /** Headlights (yellowish beam ahead) and red taillights of the cars. */
  private drawHeadlights(ctx: CanvasRenderingContext2D, scene: LightScene, view: View, n: number): void {
    if (!scene.cars.length) return;
    const beam = glowSprite('#fff1c4', 64);
    const tail = glowSprite('#ff4a3a', 16);
    for (const car of scene.cars) {
      if (car.x < view.x0 - 80 || car.x > view.x1 + 80 || car.y < view.y0 - 30 || car.y > view.y1 + 30) continue;
      const front = car.x + car.dir * 16;
      ctx.globalAlpha = 0.55 * n;
      ctx.drawImage(beam, Math.round(front + (car.dir > 0 ? 0 : -46)), Math.round(car.y - 15), 46, 16);
      ctx.globalAlpha = 0.8 * n;
      ctx.drawImage(tail, Math.round(car.x - car.dir * 16 - 4), Math.round(car.y - 11), 8, 8);
    }
  }

  /** Fireflies blinking over the lawn and the gardens (only when night has fully fallen). */
  private drawFireflies(ctx: CanvasRenderingContext2D, scene: LightScene, view: View, now: number, k: number): void {
    if (this.fliesFor !== scene.exterior) this.seedFireflies(scene.exterior);
    const dot = glowSprite('#d8ff7a', 12);
    const t = now / 1000;
    for (const f of this.flies) {
      const x = f.x + Math.sin(t * f.sx + f.ph) * 7;
      const y = f.y + Math.cos(t * f.sy + f.ph * 1.7) * 4;
      if (x < view.x0 - 8 || x > view.x1 + 8 || y < view.y0 - 8 || y > view.y1 + 8) continue;
      const on = Math.sin(t * f.blink + f.ph * 3);
      if (on <= 0.2) continue;
      const a = Math.pow((on - 0.2) / 0.8, 2) * k;
      ctx.globalAlpha = 0.9 * a;
      ctx.drawImage(dot, Math.round(x - 6), Math.round(y - 6));
      ctx.globalAlpha = a;
      ctx.fillStyle = '#f4ffc8';
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
  }

  /** Fireflies near bushes, flowers and trees (positions fixed by the seed). */
  private seedFireflies(ext: ExteriorLayout): void {
    this.fliesFor = ext;
    this.flies = [];
    const rng = mulberry32(0xf1e5 + ext.bounds.w);
    const spots = ext.props.filter((p) => p.kind === 'bush' || p.kind === 'flowers' || p.kind === 'tree');
    if (!spots.length) return;
    for (let i = 0; i < FIREFLIES; i++) {
      const p = spots[Math.floor(rng() * spots.length)];
      this.flies.push({
        x: p.x + (rng() - 0.5) * 28,
        y: p.y - 6 - rng() * 14,
        ph: rng() * Math.PI * 2,
        sx: 0.25 + rng() * 0.35,
        sy: 0.3 + rng() * 0.4,
        blink: 0.6 + rng() * 0.9,
      });
    }
  }
}
