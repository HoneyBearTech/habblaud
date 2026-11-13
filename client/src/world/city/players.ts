// Players on the street (pure): mine (immediate local movement, collision by the `isWalkable` of city.ts, A* path,
// sending of `move` up to 10 per second) and the others (position samples at 5/s for the 20 nearest and at 2.5/s for
// the others, drawn a little behind and interpolated between them; the delay follows the interval between each
// one's samples). Positions in TILES (the feet point; the same as the protocol).
import type { Dir } from '../../art/api';
import type { Direction } from '../../../../shared/world/protocol';
import { walkable as cityWalkable } from './layout';

/** Speeds (tiles/s): the office's. The server accepts up to 6 × 1.2. */
export const WALK_TPS = 3.2;
export const RUN_TPS = 6;
/**
 * Delay with which the others are drawn (ms): the largest recent interval between each one's samples plus slack for
 * the network, so there is always a sample ahead (5/s: ~260 ms; 2.5/s: ~460 ms), between the minimum and the maximum.
 */
export const INTERP_MIN_MS = 150;
export const INTERP_MAX_MS = 700;
const INTERP_MARGIN_MS = 60;
/** Intervals above this are not the cadence (the player stopped and the server sent nothing): they do not count. */
const CADENCE_MAX_GAP_MS = 1_000;
/** How many recent intervals count. */
const CADENCE_GAPS = 4;
/** How much the delay changes per clock ms (rising, the drawing runs at 0.5×; falling, at 1.25×): never goes back. */
const DELAY_UP_RATE = 0.5;
const DELAY_DOWN_RATE = 0.25;
/** Minimum interval between two `move` (10/s). */
export const MOVE_INTERVAL_MS = 100;
/** Samples kept per player. */
const MAX_SAMPLES = 10;

export const DIR_TO_PROTO: Readonly<Record<Dir, Direction>> = { up: 'n', down: 's', left: 'w', right: 'e' };
export const PROTO_TO_DIR: Readonly<Record<Direction, Dir>> = { n: 'up', s: 'down', w: 'left', e: 'right' };

/** Dominant direction of a displacement (keeps the previous one when stopped). */
export function dirOf(dx: number, dy: number, fallback: Dir): Dir {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

// ------------------------------------------------------------------ other players

export interface Sample {
  t: number;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
}

/** Stores the sample in time order, with a limit. */
export function pushSample(samples: Sample[], s: Sample): void {
  const last = samples[samples.length - 1];
  if (last && s.t < last.t) s = { ...s, t: last.t };
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export interface Interpolated {
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
  /** Estimated speed (tiles/s) between the two samples. */
  speed: number;
}

/** Target delay (ms) for a player's samples: the largest of the last intervals between them, plus the slack. */
export function interpDelay(samples: readonly Sample[]): number {
  let worst = 0;
  let n = 0;
  for (let i = samples.length - 1; i > 0 && n < CADENCE_GAPS; i--) {
    const gap = samples[i]!.t - samples[i - 1]!.t;
    if (gap <= 0 || gap > CADENCE_MAX_GAP_MS) continue;
    worst = Math.max(worst, gap);
    n++;
  }
  return Math.min(INTERP_MAX_MS, Math.max(INTERP_MIN_MS, worst + INTERP_MARGIN_MS));
}

/** Brings the current delay to the target little by little (`dtMs` of clock), without the drawing going back in time. */
export function stepDelay(current: number, target: number, dtMs: number): number {
  if (target > current) return Math.min(target, current + dtMs * DELAY_UP_RATE);
  return Math.max(target, current - dtMs * DELAY_DOWN_RATE);
}

/**
 * Position at instant `t` (the "now" minus the delay): linear between the two samples around it; before the first,
 * the first; after the last, the last (stopped if it is already old).
 */
export function sampleAt(samples: readonly Sample[], t: number): Interpolated | null {
  const n = samples.length;
  if (!n) return null;
  const first = samples[0]!;
  if (t <= first.t) return { x: first.x, y: first.y, dir: first.dir, moving: first.moving && n > 1, speed: 0 };
  for (let i = 1; i < n; i++) {
    const b = samples[i]!;
    if (t > b.t) continue;
    const a = samples[i - 1]!;
    const span = Math.max(1, b.t - a.t);
    const k = Math.min(1, Math.max(0, (t - a.t) / span));
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, dir: b.dir, moving: dist > 1e-3 || b.moving, speed: (dist * 1000) / span };
  }
  const last = samples[n - 1]!;
  // the last sample said "walking", but it has been a while: stopped (the next one arrives when they move)
  const stale = t - last.t > 400;
  return { x: last.x, y: last.y, dir: last.dir, moving: last.moving && !stale, speed: 0 };
}

// ------------------------------------------------------------------ my player

export type Walkable = (x: number, y: number) => boolean;

/**
 * Walks (dx, dy) tiles from (x, y), one axis at a time (slides along the wall), without entering where you cannot step.
 * Large steps are broken into pieces of at most half a tile, so as not to cut through corners.
 */
export function stepMove(x: number, y: number, dx: number, dy: number, can: Walkable = cityWalkable): { x: number; y: number; blocked: boolean } {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.5));
  let blocked = false;
  for (let i = 0; i < n; i++) {
    const nx = x + dx / n;
    if (can(nx, y)) x = nx;
    else blocked = true;
    const ny = y + dy / n;
    if (can(x, ny)) y = ny;
    else blocked = true;
  }
  return { x, y, blocked };
}

export interface MoveIntent {
  /** Direction of the keys (-1..1 on each axis; 0,0 = none). */
  dx: number;
  dy: number;
  run: boolean;
}

export class LocalPlayer {
  x: number;
  y: number;
  dir: Dir = 'down';
  moving = false;
  running = false;
  /** Points (tiles) of the click path, already in the format [x0, y0, x1, y1...]. */
  private path: number[] = [];
  private pathI = 0;
  private pathRun = false;
  /** Time (ms) in the current pose, for the animation frames. */
  animT = 0;

  constructor(
    x: number,
    y: number,
    private readonly can: Walkable = cityWalkable,
  ) {
    this.x = x;
    this.y = y;
  }

  get hasPath(): boolean {
    return this.pathI < this.path.length;
  }

  /** Path (points in tiles) to follow. */
  follow(points: number[], run: boolean): void {
    this.path = points;
    this.pathI = 0;
    this.pathRun = run;
  }

  stopPath(): void {
    this.path = [];
    this.pathI = 0;
  }

  /** Server correction (`pos`): goes there right away and forgets the path. */
  correct(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.stopPath();
  }

  /** Advances `dt` seconds. Keys take priority over the click path. */
  update(dt: number, intent: MoveIntent): void {
    const prevMoving = this.moving;
    const prevRun = this.running;
    dt = Math.min(0.1, Math.max(0, dt));
    let dx = intent.dx;
    let dy = intent.dy;
    if (dx || dy) {
      this.stopPath();
      const len = Math.hypot(dx, dy);
      // normalized diagonal: never faster than the running speed
      dx /= len;
      dy /= len;
      const v = (intent.run ? RUN_TPS : WALK_TPS) * dt;
      const r = stepMove(this.x, this.y, dx * v, dy * v, this.can);
      this.dir = dirOf(dx, dy, this.dir);
      this.moving = Math.hypot(r.x - this.x, r.y - this.y) > 1e-4;
      this.running = intent.run && this.moving;
      this.x = r.x;
      this.y = r.y;
    } else if (this.hasPath) {
      let budget = (this.pathRun ? RUN_TPS : WALK_TPS) * dt;
      this.moving = true;
      this.running = this.pathRun;
      while (budget > 0 && this.hasPath) {
        const tx = this.path[this.pathI]!;
        const ty = this.path[this.pathI + 1]!;
        const ddx = tx - this.x;
        const ddy = ty - this.y;
        const d = Math.hypot(ddx, ddy);
        if (d <= budget) {
          this.x = tx;
          this.y = ty;
          budget -= d;
          this.pathI += 2;
          if (d > 1e-6) this.dir = dirOf(ddx, ddy, this.dir);
        } else {
          this.x += (ddx / d) * budget;
          this.y += (ddy / d) * budget;
          this.dir = dirOf(ddx, ddy, this.dir);
          budget = 0;
        }
      }
      if (!this.hasPath) {
        this.moving = false;
        this.running = false;
      }
    } else {
      this.moving = false;
      this.running = false;
    }
    if (prevMoving !== this.moving || prevRun !== this.running) this.animT = 0;
    else this.animT += dt * 1000;
  }
}

/** Converts the A* path (integer tiles of the local grid) into points (tile centers) up to the fine destination. */
export function pathPoints(cells: readonly number[], ox: number, oy: number, goal: { x: number; y: number } | null): number[] {
  const out: number[] = [];
  for (let i = 0; i < cells.length; i += 2) out.push(cells[i]! + ox + 0.5, cells[i + 1]! + oy + 0.5);
  if (goal && out.length >= 2) {
    // the last point becomes the exact click point (within the same tile)
    out[out.length - 2] = goal.x;
    out[out.length - 1] = goal.y;
  } else if (goal && !out.length) out.push(goal.x, goal.y);
  return out;
}

/**
 * Position for the wire, in hundredths of a tile, always truncated down: rounding could take someone who stopped right
 * at the north or west edge of a lot (y = 11.996) into it (12.00), and the server would send back `pos`. Truncating
 * never changes tiles.
 */
export function wirePos(v: number): number {
  return Math.floor(v * 100) / 100;
}

/**
 * When to send `move`: at most one every 100 ms, only when the position or the "walking" changed since the last one.
 * The "I stopped" always goes out (in the next free interval).
 */
export class MoveSender {
  private lastAt = -Infinity;
  private last: { x: number; y: number; dir: Direction; moving: boolean } | null = null;

  constructor(private readonly send: (m: { t: 'move'; x: number; y: number; dir: Direction; moving: boolean }) => void) {}

  tick(now: number, p: { x: number; y: number; dir: Dir; moving: boolean }): boolean {
    if (now - this.lastAt < MOVE_INTERVAL_MS) return false;
    const cur = { x: wirePos(p.x), y: wirePos(p.y), dir: DIR_TO_PROTO[p.dir], moving: p.moving };
    const l = this.last;
    if (l && l.x === cur.x && l.y === cur.y && l.dir === cur.dir && l.moving === cur.moving) return false;
    this.lastAt = now;
    this.last = cur;
    this.send({ t: 'move', ...cur });
    return true;
  }

  /**
   * Repeats the stopped position (tab in the background: the server doesn't take the player off the street).
   * No time: the caller uses a different clock than `tick`, and keeping its time silenced the sends until a `reset`.
   */
  keepAlive(p: { x: number; y: number; dir: Dir }): void {
    const cur = { x: wirePos(p.x), y: wirePos(p.y), dir: DIR_TO_PROTO[p.dir], moving: false };
    this.lastAt = -Infinity;
    this.last = cur;
    this.send({ t: 'move', ...cur });
  }

  /** Forgets the last one sent (after a correction, the next tick sends again). */
  reset(): void {
    this.last = null;
    this.lastAt = -Infinity;
  }
}
