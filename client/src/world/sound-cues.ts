// Ambient sounds suggested by the world: keyboard of whoever works in view, "ding" when the door of
// an elevator opens (someone arrives or leaves) and the hangouts (ping-pong paddle hits, arcade). It
// only watches the simulation and the camera; the UI decides whether it plays (preference, volume, hidden tab).
import type { SoundCue } from './api';
import type { Camera } from './camera';
import type { Character } from './sim/character';
import type { Sim } from './sim/sim';

/** Rechecks who is typing this often (ms). */
const KEYS_TICK_MS = 160;
/** Period (ms) of one crossing of the ping-pong ball (the same as in the drawing). */
const PINGPONG_PERIOD = 1_100;

interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class SoundCues {
  private doors: number[] = [];
  private keysAt = 0;
  private nextKeysAt = 0;
  private nextArcadeAt = 0;
  private rally = new Map<number, number>();

  constructor(
    private readonly sim: Sim,
    private readonly camera: Camera,
    private readonly rng: () => number = Math.random,
  ) {}

  update(now: number, emit: (cue: SoundCue) => void): void {
    const a = this.camera.screenToWorld(0, 0);
    const b = this.camera.screenToWorld(this.camera.viewW, this.camera.viewH);
    const view = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    // from far away (low zoom) everything gets quieter
    const near = Math.max(0.45, Math.min(1, 0.25 + this.camera.zoom * 0.25));
    this.elevators(view, emit);
    this.keys(now, view, near, emit);
    this.social(now, view, near, emit);
  }

  private pan(x: number, v: ViewRect): number {
    const half = Math.max(1, (v.x1 - v.x0) / 2);
    return Math.max(-0.7, Math.min(0.7, ((x - (v.x0 + v.x1) / 2) / half) * 0.7));
  }

  private inView(x: number, y: number, v: ViewRect, m = 16): boolean {
    return x > v.x0 - m && x < v.x1 + m && y > v.y0 - m && y < v.y1 + m;
  }

  /** "Ding" when the door starts to open; off screen, quieter (it still tells that someone arrived). */
  private elevators(view: ViewRect, emit: (cue: SoundCue) => void): void {
    this.sim.elevators.forEach((e, i) => {
      const prev = this.doors[i];
      this.doors[i] = e.door;
      if (prev === undefined || prev > 0.01 || e.door <= 0.01) return;
      const spot = this.sim.spots.get(e.spotId);
      if (!spot) return;
      emit({ kind: 'elevator', gain: this.inView(spot.x, spot.y, view, 24) ? 1 : 0.5, pan: this.pan(spot.x, view) });
    });
  }

  /** Bursts of keys, more frequent the more people type on screen. */
  private keys(now: number, view: ViewRect, near: number, emit: (cue: SoundCue) => void): void {
    if (now - this.keysAt < KEYS_TICK_MS) return;
    this.keysAt = now;
    let n = 0;
    let sx = 0;
    for (const ch of this.sim.chars.values()) {
      if (!typing(ch) || !this.inView(ch.x, ch.y, view)) continue;
      n++;
      sx += ch.x;
    }
    if (!n || now < this.nextKeysAt) return;
    if (this.rng() > Math.min(0.8, 0.3 + 0.12 * n)) return;
    this.nextKeysAt = now + (700 + this.rng() * 1500) / Math.sqrt(Math.min(n, 6));
    emit({ kind: 'keys', gain: near * Math.min(1, 0.6 + 0.1 * n), pan: this.pan(sx / n, view), count: 2 + Math.floor(this.rng() * 5) });
  }

  /** Ping-pong (paddle hits and bounces in the rhythm of the drawn ball) and the arcade. */
  private social(now: number, view: ViewRect, near: number, emit: (cue: SoundCue) => void): void {
    const alive = new Set<number>();
    for (const g of this.sim.social.gatherings) {
      if (g.phase !== 'run') continue;
      if (g.kind !== 'pingpong' && g.kind !== 'arcade') continue;
      let x = 0;
      let y = 0;
      let k = 0;
      for (const m of g.members) {
        if (m.role !== 'player' || m.left) continue;
        const ch = this.sim.chars.get(m.id);
        if (!ch) continue;
        x += ch.x;
        y += ch.y;
        k++;
      }
      if (!k) continue;
      x /= k;
      y /= k;
      if (!this.inView(x, y, view, 24)) continue;
      if (g.kind === 'pingpong') {
        alive.add(g.id);
        // every half crossing: paddle hit (ends) or bounce on the table (middle), as in the drawing
        const seg = Math.floor(((now - g.startAt) % (PINGPONG_PERIOD * 2)) / (PINGPONG_PERIOD / 2));
        const prev = this.rally.get(g.id);
        this.rally.set(g.id, seg);
        if (prev !== undefined && prev !== seg) emit({ kind: seg % 2 === 0 ? 'pingpong' : 'table', gain: near, pan: this.pan(x, view) });
      } else if (now >= this.nextArcadeAt) {
        this.nextArcadeAt = now + 500 + this.rng() * 900;
        emit({ kind: 'arcade', gain: near * 0.8, pan: this.pan(x, view) });
      }
    }
    for (const id of this.rally.keys()) if (!alive.has(id)) this.rally.delete(id);
  }
}

/** Seated at their own desk, typing. */
function typing(ch: Character): boolean {
  return ch.mode === 'work' && ch.seated && ch.pose === 'type' && !ch.leaving && !ch.inside && ch.alpha > 0.5;
}
