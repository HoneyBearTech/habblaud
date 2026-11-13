// The city square (Phase 5): the thermometer of the week's collective goal ("10 thousand hours of agents working"),
// the city hall sign ("the city used ≈ X this week" and the lit buildings), the fireworks when the goal is reached
// (20 s) and the week's decoration for everyone after that (pennants between the lampposts and, from the second goal
// on, the season's decoration: pumpkins in October, tree and presents at the end of the year). All cosmetic and in
// the browser, from `city` and `city.fireworks` (the server only adds up, and only with 10 lit buildings or more).
// Pure models (tested); the drawing is in world px (the signs and the decorations with depth, the fireworks on top
// of the night) and the sign texts in screen space (sharp, like the building nameplates).
import { tr } from '../../../../shared/i18n';
import { blockOrigin, FOUNTAIN, PLAZA } from '../../../../shared/world/city';
import { CITY_GOAL_IDS, type CityGoal } from '../../../../shared/world/protocol';
import type { WorldSceneCity } from '../../../../shared/world/api';
import { cityGoalLabel, compactNumber, tokenBandText } from '../../../../shared/world/social-labels';
import { renderSeasonalProp, type SeasonalProp } from '../../art/seasonal';
import { TILE } from '../../art/api';
import { CONFETTI_COLORS, Particles } from '../render/particles';

/** Duration of the fireworks in the square. */
export const FIREWORKS_MS = 20_000;

// ------------------------------------------------------------------ models

export interface GoalView {
  /** 0..1 of the week's goal. */
  pct: number;
  /** "80%". */
  pctText: string;
  /** "10 thousand hours of agents working". */
  label: string;
  /** "8 thousand of 10 thousand h". */
  progressText: string;
  /** Goals reached this week (0 to 3): the square's decoration. */
  reached: number;
}

/** How many of the week's goals are reached (the `goal` one is the first not reached, or the last, already reached). */
export function goalsReached(goal: CityGoal | undefined): number {
  if (!goal) return 0;
  const i = CITY_GOAL_IDS.indexOf(goal.label);
  if (i < 0) return 0;
  return i + (goal.progress >= goal.target ? 1 : 0);
}

/** The thermometer: null with no goal (with fewer than 10 lit buildings the server does not send it). */
export function goalView(city: WorldSceneCity | undefined | null): GoalView | null {
  const g = city?.goal;
  if (!g || !(g.target > 0)) return null;
  const pct = Math.max(0, Math.min(1, g.progress / g.target));
  return {
    pct,
    pctText: `${Math.floor(pct * 100)}%`,
    label: cityGoalLabel(g.label, g.target),
    progressText: tr('{0} of {1} h', [compactNumber(Math.floor(g.progress)), compactNumber(g.target)]),
    reached: goalsReached(g),
  };
}

/** The goal just reached (`goalId` = "<monday>:<CityGoalId>" from `city.fireworks`), full, during the fireworks. */
export function reachedGoalView(goalId: string): GoalView | null {
  const label = goalId.slice(goalId.lastIndexOf(':') + 1) as CityGoal['label'];
  const i = CITY_GOAL_IDS.indexOf(label);
  if (i < 0) return null;
  return { pct: 1, pctText: '100%', label: cityGoalLabel(label), progressText: tr('Goal reached!'), reached: i + 1 };
}

/** The city hall sign: the city's tokens for the week (as a range) and the lit buildings. */
export function cityHallView(city: WorldSceneCity | undefined | null): { tokens: string; lit: string } | null {
  if (!city) return null;
  return {
    tokens: city.tokensBand === undefined ? tr('The total shows up with 10 buildings or more.') : tr('The city used ≈ {0} this week', [tokenBandText(city.tokensBand)]),
    lit: city.lit === 1 ? tr('1 building lit now') : tr('{0} buildings lit now', [compactNumber(city.lit)]),
  };
}

/** The season's decoration (by the viewer's date): pumpkins in October, Christmas November to December, party the rest. */
export type Ornament = 'halloween' | 'christmas' | 'party';

export function ornamentFor(date: Date): Ornament {
  const m = date.getMonth();
  if (m === 9) return 'halloween';
  if (m === 10 || m === 11) return 'christmas';
  return 'party';
}

// ------------------------------------------------------------------ where things go in the square (world px)

const O = blockOrigin(PLAZA);
const PX = (t: number) => (O.x + t) * TILE;
const PY = (t: number) => (O.y + t) * TILE;

/** The two signs (center and base, world px): the thermometer left of the north path, city hall on the right. */
export const BOARDS = {
  goal: { x: PX(15.5), y: PY(7.6) },
  hall: { x: PX(26.5), y: PY(7.6) },
  w: 84,
  h: 52,
  posts: 12,
} as const;

/** The center of the fountain (world px): where the fireworks rise from. */
export const FOUNTAIN_PX = { x: PX(FOUNTAIN.x + FOUNTAIN.w / 2), y: PY(FOUNTAIN.y + FOUNTAIN.h / 2) };

/** The square's lampposts that hold the pennants (world px, the lamp). */
export const BUNTING: ReadonlyArray<readonly [number, number, number, number]> = [
  [PX(12) + 8, PY(4) - 30, PX(30) + 8, PY(4) - 30],
  [PX(12) + 8, PY(19) - 30, PX(30) + 8, PY(19) - 30],
];

// ------------------------------------------------------------------ fireworks

const SPARK_COLORS: readonly string[] = ['#ff5d73', '#ffd166', '#7cf3ff', '#b28dff', '#6dff9e', '#ff9f43', '#ffffff', '#ff7ad9'];
/** Index of white (the rockets' trail). */
const WHITE = 6;

interface Rocket {
  x: number;
  y: number;
  vx: number;
  vy: number;
  burstY: number;
  color: number;
}

/**
 * Fireworks: rockets that rise from the square and burst into balls of sparks with a flash (fixed pool in typed
 * arrays, no allocation per frame), plus the office confetti (render/particles.ts) falling on the square at the start.
 */
export class Fireworks {
  private readonly cap = 2400;
  private n = 0;
  private readonly x = new Float32Array(this.cap);
  private readonly y = new Float32Array(this.cap);
  private readonly vx = new Float32Array(this.cap);
  private readonly vy = new Float32Array(this.cap);
  private readonly age = new Float32Array(this.cap);
  private readonly life = new Float32Array(this.cap);
  private readonly color = new Uint8Array(this.cap);
  private readonly rockets: Rocket[] = [];
  /** Flashes of the bursts: x, y, color and when. */
  private readonly flashes: Array<{ x: number; y: number; color: number; at: number }> = [];
  readonly confetti = new Particles(500);
  private until = 0;
  private nextLaunch = 0;
  private started = 0;
  private clock = 0;

  constructor(private readonly random: () => number = Math.random) {}

  get active(): boolean {
    return this.n > 0 || this.rockets.length > 0 || this.confetti.count > 0 || this.flashes.length > 0;
  }

  /** The fireworks are in the air (until the end of the 20 s). */
  showing(now: number): boolean {
    return now < this.until;
  }

  /** Starts the party: `ms` of rockets, the first volley of four at once and the confetti. */
  start(now: number, ms = FIREWORKS_MS): void {
    this.started = now;
    this.until = now + ms;
    this.nextLaunch = now + 700;
    for (let i = 0; i < 4; i++) this.launch((i + 0.5) / 4);
    for (let i = 0; i < 40; i++) this.confetti.confettiFall(FOUNTAIN_PX.x + (this.random() - 0.5) * 560, FOUNTAIN_PX.y - 200 - this.random() * 80, 260 + this.random() * 80);
  }

  stop(): void {
    this.until = 0;
    this.n = 0;
    this.rockets.length = 0;
    this.flashes.length = 0;
    this.confetti.clear();
  }

  private launch(spread = this.random()): void {
    const x = FOUNTAIN_PX.x + (spread - 0.5) * 520;
    const burstY = FOUNTAIN_PX.y - 170 - this.random() * 120;
    // rises to the burst point in ~1 s, with a slight sideways drift
    this.rockets.push({ x, y: FOUNTAIN_PX.y - 6, vx: (this.random() - 0.5) * 30, vy: -(250 + this.random() * 60), burstY, color: Math.floor(this.random() * SPARK_COLORS.length) });
  }

  private spark(x: number, y: number, vx: number, vy: number, life: number, color: number): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = life;
    this.color[i] = color;
  }

  private burst(r: Rocket): void {
    const kind = this.random();
    const count = 70 + Math.floor(this.random() * 40);
    const speed = 120 + this.random() * 60;
    const second = (r.color + 1 + Math.floor(this.random() * (SPARK_COLORS.length - 1))) % SPARK_COLORS.length;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + this.random() * 0.15;
      // ring (shell), full ball or heart (the city's gesture)
      let s = kind < 0.3 ? speed : speed * Math.sqrt(0.15 + this.random() * 0.85);
      let dx = Math.cos(a);
      let dy = Math.sin(a);
      if (kind > 0.85) {
        const t = a;
        dx = (16 * Math.sin(t) ** 3) / 17;
        dy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17;
        s = speed * 0.9;
      }
      this.spark(r.x, r.y, dx * s, dy * s, 1.3 + this.random() * 0.8, kind > 0.85 ? 0 : i % 4 === 0 ? second : r.color);
    }
    this.flashes.push({ x: r.x, y: r.y, color: r.color, at: this.clock });
  }

  update(now: number, dt: number): void {
    const d = Math.min(0.1, Math.max(0, dt));
    this.clock = now;
    if (now < this.until && now >= this.nextLaunch) {
      this.launch();
      if (this.random() < 0.45) this.launch();
      // the "grand finale": in the last 15 %, one volley after another
      const t = (now - this.started) / Math.max(1, this.until - this.started);
      this.nextLaunch = now + (t > 0.85 ? 120 : 300 + this.random() * 380);
    }
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]!;
      r.x += r.vx * d;
      r.y += r.vy * d;
      r.vy += 70 * d;
      // the rocket's trail of sparks
      this.spark(r.x + (this.random() - 0.5) * 2, r.y + 3, (this.random() - 0.5) * 10, 14 + this.random() * 12, 0.45, WHITE);
      if (r.y <= r.burstY || r.vy >= -30) {
        this.burst(r);
        this.rockets.splice(i, 1);
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) if (now - this.flashes[i]!.at > 320) this.flashes.splice(i, 1);
    let i = 0;
    while (i < this.n) {
      this.age[i] += d;
      if (this.age[i] >= this.life[i]) {
        const j = --this.n;
        this.x[i] = this.x[j];
        this.y[i] = this.y[j];
        this.vx[i] = this.vx[j];
        this.vy[i] = this.vy[j];
        this.age[i] = this.age[j];
        this.life[i] = this.life[j];
        this.color[i] = this.color[j];
        continue;
      }
      this.vx[i] *= Math.max(0, 1 - 1.15 * d);
      this.vy[i] = this.vy[i] * Math.max(0, 1 - 1.15 * d) + 52 * d;
      this.x[i] += this.vx[i] * d;
      this.y[i] += this.vy[i] * d;
      i++;
    }
    this.confetti.update(d);
  }

  /** On top of everything (world px): the flashes, the rockets, the sparks with glow and the confetti. */
  draw(ctx: CanvasRenderingContext2D, now: number, view: { x0: number; y0: number; x1: number; y1: number }, night: number): void {
    if (!this.active) return;
    ctx.save();
    const glow = 0.35 + night * 0.65;
    // flashes of the bursts (they add light: at night, they light up the sky around them)
    ctx.globalCompositeOperation = 'lighter';
    for (const f of this.flashes) {
      const t = (now - f.at) / 320;
      if (t < 0 || t > 1) continue;
      const rad = 18 + t * 40;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, rad);
      g.addColorStop(0, `rgba(255,255,255,${(0.55 * (1 - t) * glow).toFixed(3)})`);
      g.addColorStop(0.4, `${SPARK_COLORS[f.color]}${Math.round(90 * (1 - t) * glow).toString(16).padStart(2, '0')}`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(f.x - rad, f.y - rad, rad * 2, rad * 2);
    }
    // glow around each spark
    for (let i = 0; i < this.n; i += 2) {
      const left = 1 - this.age[i] / this.life[i];
      ctx.globalAlpha = left * 0.22 * glow;
      ctx.fillStyle = SPARK_COLORS[this.color[i] % SPARK_COLORS.length]!;
      ctx.fillRect(Math.round(this.x[i]) - 1, Math.round(this.y[i]) - 1, 4, 4);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const r of this.rockets) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff4c8';
      ctx.fillRect(Math.round(r.x), Math.round(r.y), 2, 3);
    }
    for (let i = 0; i < this.n; i++) {
      const x = Math.round(this.x[i]);
      const y = Math.round(this.y[i]);
      if (x < view.x0 - 4 || x > view.x1 + 4 || y < view.y0 - 4 || y > view.y1 + 4) continue;
      const left = 1 - this.age[i] / this.life[i];
      // they blink at the end of their life (the "crackle")
      if (left < 0.35 && Math.sin(now / 35 + i * 1.7) < 0) continue;
      ctx.globalAlpha = Math.min(1, left * 1.8);
      ctx.fillStyle = left > 0.75 ? '#fffbe8' : SPARK_COLORS[this.color[i] % SPARK_COLORS.length]!;
      const size = left > 0.45 ? 2 : 1;
      ctx.fillRect(x, y, size, size);
    }
    ctx.globalAlpha = 1;
    this.confetti.draw(ctx, view.x0, view.y0, view.x1, view.y1, now);
    ctx.restore();
  }
}

// ------------------------------------------------------------------ the square's signs (world px)

/** A wooden sign on two posts (center at `cx`, base at `by`), with the dark panel. */
function drawBoardFrame(ctx: CanvasRenderingContext2D, cx: number, by: number, accent: string): { x: number; y: number; w: number; h: number } {
  const w = BOARDS.w;
  const h = BOARDS.h;
  const x = Math.round(cx - w / 2);
  const y = Math.round(by - BOARDS.posts - h);
  // shadow on the ground
  ctx.fillStyle = 'rgba(30,36,48,0.22)';
  ctx.fillRect(x + 4, by - 2, w - 4, 3);
  // posts
  for (const px of [x + 8, x + w - 11]) {
    ctx.fillStyle = '#3b2a1f';
    ctx.fillRect(px, y + h - 2, 3, BOARDS.posts + 2);
    ctx.fillStyle = '#6b4a33';
    ctx.fillRect(px, y + h - 2, 1, BOARDS.posts + 2);
  }
  // frame and panel
  ctx.fillStyle = '#2a1d16';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#8a5f3f';
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
  ctx.fillStyle = '#a8784f';
  ctx.fillRect(x + 1, y + 1, w - 2, 1);
  ctx.fillStyle = '#1b2233';
  ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
  // color band of the title
  ctx.fillStyle = accent;
  ctx.fillRect(x + 3, y + 3, w - 6, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(x + 3, y + 3, w - 6, 1);
  return { x: x + 3, y: y + 3, w: w - 6, h: h - 6 };
}

/** The thermometer (left panel): tube with the goal's column, bulb and 25 % marks. */
export function drawGoalBoard(ctx: CanvasRenderingContext2D, goal: GoalView | null, now: number): void {
  const p = drawBoardFrame(ctx, BOARDS.goal.x, BOARDS.goal.y, '#c8443c');
  const tx = p.x + 6;
  const top = p.y + 13;
  const bottom = p.y + p.h - 7;
  // glass tube
  ctx.fillStyle = '#0d1018';
  ctx.fillRect(tx - 1, top - 1, 6, bottom - top + 2);
  ctx.fillStyle = '#d8e4f0';
  ctx.fillRect(tx, top, 4, bottom - top);
  // bulb
  ctx.fillStyle = '#0d1018';
  ctx.fillRect(tx - 2, bottom - 1, 8, 6);
  ctx.fillStyle = '#e8473f';
  ctx.fillRect(tx - 1, bottom, 6, 4);
  // column (rises slowly to the value and pulses at the top)
  const pct = goal?.pct ?? 0;
  const hgt = Math.round((bottom - top) * pct);
  if (hgt > 0) {
    ctx.fillStyle = '#e8473f';
    ctx.fillRect(tx + 1, bottom - hgt, 2, hgt);
    ctx.fillStyle = '#ff9c74';
    ctx.fillRect(tx + 1, bottom - hgt, 1, hgt);
    if (Math.sin(now / 300) > 0) {
      ctx.fillStyle = '#ffd7a0';
      ctx.fillRect(tx + 1, bottom - hgt, 2, 1);
    }
  }
  // 25 % marks
  ctx.fillStyle = '#7d8aa3';
  for (let k = 1; k < 4; k++) ctx.fillRect(tx + 5, Math.round(bottom - ((bottom - top) * k) / 4), 2, 1);
  // the goal's flag at the top
  ctx.fillStyle = '#ffd166';
  ctx.fillRect(tx + 6, top - 1, 4, 3);
  ctx.fillStyle = '#c9a24a';
  ctx.fillRect(tx + 5, top - 1, 1, 6);
}

/** The city hall sign (right panel): a little lit building in the corner. */
export function drawHallBoard(ctx: CanvasRenderingContext2D, lit: boolean): void {
  const p = drawBoardFrame(ctx, BOARDS.hall.x, BOARDS.hall.y, '#2f6fa8');
  // the miniature city hall: pediment, columns and lit windows
  const x = p.x + 4;
  const y = p.y + 15;
  ctx.fillStyle = '#c9c2b2';
  ctx.fillRect(x, y + 5, 14, 11);
  ctx.fillStyle = '#e8e2d4';
  ctx.fillRect(x - 1, y + 3, 16, 2);
  ctx.fillRect(x + 2, y + 1, 10, 2);
  ctx.fillRect(x + 5, y, 4, 1);
  ctx.fillStyle = lit ? '#ffd27a' : '#4a5468';
  for (const cx of [x + 2, x + 6, x + 10]) ctx.fillRect(cx, y + 7, 2, 4);
  ctx.fillStyle = '#8f8676';
  ctx.fillRect(x - 1, y + 16, 16, 1);
}

/** The texts of the two signs, in screen space (CSS px), from the panels' rectangles. */
export function boardTextRects(): { goal: { x: number; y: number; w: number }; hall: { x: number; y: number; w: number } } {
  const top = (by: number) => by - BOARDS.posts - BOARDS.h + 3;
  return {
    goal: { x: BOARDS.goal.x - BOARDS.w / 2 + 3, y: top(BOARDS.goal.y), w: BOARDS.w - 6 },
    hall: { x: BOARDS.hall.x - BOARDS.w / 2 + 3, y: top(BOARDS.hall.y), w: BOARDS.w - 6 },
  };
}

// ------------------------------------------------------------------ decorations (after the goal is reached)

/** Where the pennant string is at `t` (0..1) from one lamppost to the other (world px). */
function rope(x0: number, y0: number, x1: number, y1: number, t: number): { x: number; y: number } {
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * 14 };
}

/** Pennants from one lamppost to another (world px), swaying in the wind. */
export function drawBunting(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, now: number): void {
  const n = 24;
  ctx.fillStyle = '#4a3b2e';
  for (let i = 0; i <= 120; i++) {
    const p = rope(x0, y0, x1, y1, i / 120);
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
  }
  for (let i = 1; i < n; i++) {
    const p = rope(x0, y0, x1, y1, i / n);
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const sway = Math.sin(now / 380 + i * 0.9) > 0.4 ? 1 : 0;
    const c = CONFETTI_COLORS[i % CONFETTI_COLORS.length]!;
    // 7 × 7 pennant pointing down, with a light band on top
    ctx.fillStyle = 'rgba(20,24,33,0.35)';
    ctx.fillRect(x - 2, y + 2, 7, 1);
    ctx.fillStyle = c;
    for (let r = 0; r < 6; r++) ctx.fillRect(x - 3 + Math.floor(r / 2) + (r > 2 ? sway : 0), y + 1 + r, 7 - Math.floor(r / 2) * 2, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(x - 3, y + 1, 7, 1);
  }
}

/** The little bulbs between the pennants, on top of the night (they blink slowly). */
export function drawBuntingLights(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, now: number, night: number): void {
  if (night < 0.15) return;
  const n = 24;
  for (let i = 0; i < n; i++) {
    const p = rope(x0, y0, x1, y1, (i + 0.5) / n);
    const on = 0.55 + 0.45 * Math.sin(now / 520 + i * 1.3);
    ctx.globalAlpha = night * on;
    ctx.fillStyle = i % 3 === 0 ? '#ffd27a' : i % 3 === 1 ? '#ff9db0' : '#9ae7ff';
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
    ctx.globalAlpha = night * on * 0.25;
    ctx.fillRect(Math.round(p.x) - 2, Math.round(p.y) - 2, 6, 6);
  }
  ctx.globalAlpha = 1;
}

const seasonalCache = new Map<SeasonalProp, HTMLCanvasElement>();

/** A season decoration (office sprite, 40×64) with its base at (x, y) world px. */
export function drawSeasonal(ctx: CanvasRenderingContext2D, kind: SeasonalProp, x: number, y: number): void {
  let c = seasonalCache.get(kind);
  if (!c) {
    const { buf } = renderSeasonalProp(kind);
    c = document.createElement('canvas');
    c.width = buf.w;
    c.height = buf.h;
    c.getContext('2d')!.putImageData(new ImageData(buf.data, buf.w, buf.h), 0, 0);
    seasonalCache.set(kind, c);
  }
  ctx.drawImage(c, Math.round(x - 20), Math.round(y - 60));
}

/** Where the season decorations go around the fountain (base in world px) and which one. */
export function seasonalSpots(o: Ornament): Array<{ kind: SeasonalProp; x: number; y: number }> {
  const f = FOUNTAIN;
  const spots: Array<[number, number]> = [
    [f.x - 2.5, f.y + 1.2],
    [f.x + f.w + 2.5, f.y + 1.2],
    [f.x - 1.2, f.y + f.h + 1.1],
    [f.x + f.w + 1.2, f.y + f.h + 1.1],
  ];
  const kinds: SeasonalProp[] = o === 'halloween' ? ['pumpkin', 'pumpkin', 'ghost', 'pumpkin'] : o === 'christmas' ? ['tree', 'tree', 'gift', 'gift'] : ['gift', 'gift', 'gift', 'gift'];
  return spots.map(([tx, ty], i) => ({ kind: kinds[i]!, x: PX(tx), y: PY(ty) }));
}
