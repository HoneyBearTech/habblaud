// Tokens on the facade (Phase 5; PLAN 17.2, items 1 and 2) and the end-of-turn confetti (16.3, item 8), browser only:
// - Energy meter next to the door, like an electricity meter: 5 bars by the DAY's range (`tokens.day`) and a needle
//   that swings when the range changes.
// - Sign with 5 intensities by the WEEK's range (`tokens.week`): off, weak, normal, neon and neon with sparks.
// - Without `tokens` (the owner turned it off), none of this shows. Never the number, only the range the world
//   publishes.
// - Confetti on the facade when an `area.patch` shows fewer agents working and more idle in the same building.
// Drawn per frame, on top of the facade (the facade cache gets no new key). Pure models (tested).
import type { TokenBand, WorldBuildingPublic } from '../../../../shared/world/protocol';
import { FACADE, signRect, type FacadeModel } from './facade';

/** Sign intensity (0 off, 1 weak, 2 normal, 3 neon, 4 neon with sparks) by the week's range. */
export function signGlowLevel(week: TokenBand | undefined): 0 | 1 | 2 | 3 | 4 {
  if (week === undefined || week <= 0) return 0;
  if (week >= 4) return 4;
  return week as 1 | 2 | 3;
}

/** Lit bars of the meter (0 to 5) by the day's range. */
export function meterBars(day: TokenBand | undefined): number {
  return day === undefined ? 0 : Math.max(0, Math.min(5, Math.floor(day)));
}

/** Where the meter is (px in the facade sprite): at the shop window, beside the door; at the back, beside the canopy. */
export function meterRect(m: Pick<FacadeModel, 'side' | 'height'>): { x: number; y: number; w: number; h: number } {
  if (m.side === 'front') return { x: FACADE.w / 2 - 34, y: m.height - FACADE.ground + 12, w: 11, h: 15 };
  return { x: FACADE.w / 2 - 37, y: 0, w: 11, h: 15 };
}

/**
 * End of turn: the patch brings `agents` with fewer working and more idle than there were (the same transition the
 * local office celebrates). `prev` is what was there before the patch (the state merges in place).
 */
export function shiftEnded(prev: WorldBuildingPublic['agents'] | undefined, next: unknown): boolean {
  if (!prev || !next || typeof next !== 'object') return false;
  const n = next as { working?: unknown; idle?: unknown };
  if (typeof n.working !== 'number' || typeof n.idle !== 'number') return false;
  return n.working < prev.working && n.idle > prev.idle;
}

/** Colors of the meter's 5 bars (bottom to top): green, lime, amber, orange and hot pink. */
export const METER_COLORS: readonly string[] = ['#4fd18b', '#b7e05a', '#ffd24a', '#ff9a3c', '#ff4f8b'];

/** Power meter (world px): box, dial with a needle (`wiggle` 0..1 = how much it still swings) and 5 bars. */
export function drawMeter(ctx: CanvasRenderingContext2D, x: number, y: number, bars: number, now: number, wiggle: number, on: boolean): void {
  const X = Math.round(x);
  const Y = Math.round(y);
  // metal box with the dial
  ctx.fillStyle = '#1b1f28';
  ctx.fillRect(X, Y, 11, 15);
  ctx.fillStyle = '#5d6577';
  ctx.fillRect(X + 1, Y + 1, 9, 13);
  ctx.fillStyle = '#7d8699';
  ctx.fillRect(X + 1, Y + 1, 9, 1);
  ctx.fillStyle = on ? '#efe6c8' : '#9aa3b2';
  ctx.fillRect(X + 2, Y + 2, 7, 4);
  // needle: points by the range and swings when it changes
  const a = -Math.PI * 0.9 + (bars / 5) * Math.PI * 0.8 + Math.sin(now / 60) * 0.55 * wiggle;
  ctx.fillStyle = '#c23a3a';
  ctx.fillRect(X + 5 + Math.round(Math.cos(a) * 2.4), Y + 5 + Math.round(Math.sin(a) * 2.4), 1, 1);
  ctx.fillStyle = '#20242e';
  ctx.fillRect(X + 5, Y + 5, 1, 1);
  // the 5 bars, of increasing heights (like the phone's signal bars)
  for (let i = 0; i < 5; i++) {
    const hgt = 2 + i;
    ctx.fillStyle = on && i < bars ? METER_COLORS[i]! : '#2c313d';
    ctx.fillRect(X + 1 + i * 2, Y + 13 - hgt, 1, hgt);
  }
}

/** The glow of the lit bars (on top of the night, in `lighter`). */
export function drawMeterGlow(ctx: CanvasRenderingContext2D, x: number, y: number, bars: number, night: number): void {
  if (bars <= 0 || night < 0.05) return;
  const X = Math.round(x);
  const Y = Math.round(y);
  ctx.globalAlpha = Math.min(1, night * 1.1);
  for (let i = 0; i < bars; i++) {
    const hgt = 2 + i;
    ctx.fillStyle = METER_COLORS[i]!;
    ctx.fillRect(X + 1 + i * 2, Y + 13 - hgt, 1, hgt);
  }
  ctx.globalAlpha = Math.min(0.35, night * 0.35);
  ctx.fillStyle = METER_COLORS[bars - 1]!;
  ctx.fillRect(X - 2, Y + 5, 15, 11);
  ctx.globalAlpha = 1;
}

/** Color of the sign's neon, by intensity. */
const NEON: readonly string[] = ['', '#ffd9a0', '#ffe9b8', '#7cf3ff', '#ff6bd6'];

/**
 * The sign glowing (world px, on top of the night, in `lighter`): weak = a warm halo; normal = a stronger halo;
 * neon = a colored tube around it; neon with sparks = the tube pulsing and sparks jumping from the edges.
 */
export function drawSignGlow(ctx: CanvasRenderingContext2D, vx: number, vy: number, m: Pick<FacadeModel, 'side' | 'height'>, level: number, now: number, night: number, seed: number): void {
  if (level <= 0) return;
  const r = signRect(m);
  const x = Math.round(vx + r.x);
  const y = Math.round(vy + r.y);
  const color = NEON[level]!;
  if (level <= 2) {
    // halo: by day it hardly shows
    ctx.globalAlpha = (level === 1 ? 0.18 : 0.32) * (0.35 + night * 0.65);
    ctx.fillStyle = color;
    ctx.fillRect(x - 4, y - 3, r.w + 8, r.h + 6);
    ctx.globalAlpha = (level === 1 ? 0.12 : 0.22) * (0.35 + night * 0.65);
    ctx.fillRect(x - 8, y - 6, r.w + 16, r.h + 12);
    ctx.globalAlpha = 1;
    return;
  }
  // neon: the tube around it (with a blink now and then)
  const flick = (Math.floor(now / 90) + seed) % 47 === 0 ? 0.35 : 1;
  const pulse = level === 4 ? 0.8 + Math.sin(now / 180 + seed) * 0.2 : 1;
  ctx.globalAlpha = (0.55 + night * 0.45) * flick * pulse;
  ctx.fillStyle = color;
  ctx.fillRect(x - 3, y - 3, r.w + 6, 1);
  ctx.fillRect(x - 3, y + r.h + 2, r.w + 6, 1);
  ctx.fillRect(x - 3, y - 3, 1, r.h + 6);
  ctx.fillRect(x + r.w + 2, y - 3, 1, r.h + 6);
  ctx.globalAlpha = (0.16 + night * 0.3) * flick * pulse;
  ctx.fillRect(x - 6, y - 6, r.w + 12, r.h + 12);
  ctx.globalAlpha = 1;
  if (level < 4) return;
  // sparks: little dots that jump from the corners and fall
  for (let i = 0; i < 6; i++) {
    const ph = ((now / 700 + i * 0.37 + seed * 0.13) % 1 + 1) % 1;
    const corner = (i + seed) % 4;
    const cx = corner % 2 === 0 ? x - 3 : x + r.w + 2;
    const cy = corner < 2 ? y - 3 : y + r.h + 2;
    const dir = corner % 2 === 0 ? -1 : 1;
    const px = cx + dir * ph * 7;
    const py = cy - Math.sin(ph * Math.PI) * 6 + ph * ph * 8;
    ctx.globalAlpha = 1 - ph;
    ctx.fillStyle = i % 2 ? '#fff6b0' : color;
    ctx.fillRect(Math.round(px), Math.round(py), 1, 1);
  }
  ctx.globalAlpha = 1;
}
