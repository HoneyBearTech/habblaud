// "Waiting for the shell to finish" — PURE rules (testable without DOM) of the office gag.
//
// Comic escalation by the age of the oldest shell the agent waits for:
// - 0–3 min   ('popcorn'):  leaning back with the popcorn bucket, watching the terminal like a movie;
// - 3–10 min  ('restless'): the popcorn ran out; arms crossed and, now and then, a spin in the chair;
// - 10–25 min ('cobweb'):   cobweb in the corner (grows to 2x after 20 min) and yawns;
// - > 25 min  ('nap'):      naps at the desk, covered in cobwebs.
// Always: hourglass flipping above the head, monitor on 'progress' and speech bubble "⏳ <label> · <time>".
import type { Activity, AgentStatus, ShellJob } from '../../../../shared/types';
import type { Dir, IconName } from '../../art/api';
import { tr } from '../../../../shared/i18n';

export type ShellStage = 'popcorn' | 'restless' | 'cobweb' | 'nap';

/** Tool of the Activity that the server records when a shell ends (agreed contract). */
export const SHELL_DONE_TOOL = 'ShellDone';

/** Thresholds (ms of wait) of the escalation. */
export const SHELL_RESTLESS_MS = 3 * 60_000;
export const SHELL_COBWEB_MS = 10 * 60_000;
export const SHELL_COBWEB_BIG_MS = 20 * 60_000;
export const SHELL_NAP_MS = 25 * 60_000;

/**
 * Command in the FOREGROUND: it only becomes a "wait" after this. Quick commands (ls, git status...)
 * don't take the character out of typing.
 */
export const FOREGROUND_WAIT_MS = 10_000;

/** Full spin in the chair: duration and interval between spins ('restless' stage). */
export const SPIN_MS = 800;
export const SPIN_GAP_MIN_MS = 15_000;
export const SPIN_GAP_MAX_MS = 25_000;
/** First spin right after the popcorn runs out (doesn't wait a whole interval). */
const SPIN_FIRST_MS = 2_500;

/** Yawn ('cobweb' stage): duration and interval. */
export const YAWN_MS = 1_300;
export const YAWN_GAP_MIN_MS = 18_000;
export const YAWN_GAP_MAX_MS = 32_000;
const YAWN_FIRST_MS = 4_000;

/** The little rain cloud ('storm') sits a bit higher than the other icons: the drops fall down to the head. */
export const STORM_LIFT = 3;

/** The hourglass flips every this long (alternates 'hourglass' / 'hourglass_flip'). */
export const HOURGLASS_FLIP_MS = 1_200;

/** Speech bubble in 'important' mode: on entering the state, then for 4 s every ~30 s. */
export const SHELL_BUBBLE_ENTER_MS = 6_000;
export const SHELL_BUBBLE_EVERY_MS = 30_000;
export const SHELL_BUBBLE_SHOW_MS = 4_000;
const BUBBLE_FADE_IN_MS = 150;
const BUBBLE_FADE_OUT_MS = 400;

/** Stage of the gag by the age (ms) of the wait. */
export function shellStage(ageMs: number): ShellStage {
  if (ageMs >= SHELL_NAP_MS) return 'nap';
  if (ageMs >= SHELL_COBWEB_MS) return 'cobweb';
  if (ageMs >= SHELL_RESTLESS_MS) return 'restless';
  return 'popcorn';
}

/** Integer scale of the cobweb: 0 = no cobweb, 1x after 10 min, 2x after 20 min. */
export function cobwebScale(ageMs: number): 0 | 1 | 2 {
  if (ageMs < SHELL_COBWEB_MS) return 0;
  return ageMs >= SHELL_COBWEB_BIG_MS ? 2 : 1;
}

/** Frame of the animated hourglass. */
export function hourglassIcon(now: number): IconName {
  return Math.floor(now / HOURGLASS_FLIP_MS) % 2 ? 'hourglass_flip' : 'hourglass';
}

// ------------------------------------------------------------------ the agent's shells

/** Does it count? In the foreground, only the commands without a result (background === false). */
function counts(j: ShellJob, foregroundOnly: boolean): boolean {
  return !foregroundOnly || j.background === false;
}

/** The oldest shell considered (without allocating). `foregroundOnly`: only the foreground ones. */
export function oldestShell(shells: readonly ShellJob[] | undefined, foregroundOnly: boolean): ShellJob | null {
  if (!shells) return null;
  let best: ShellJob | null = null;
  for (const j of shells) {
    if (!counts(j, foregroundOnly) || !Number.isFinite(j.startedAt)) continue;
    if (!best || j.startedAt < best.startedAt) best = j;
  }
  return best;
}

/** How many shells the agent waits for (same criterion as `oldestShell`). */
export function countShells(shells: readonly ShellJob[] | undefined, foregroundOnly: boolean): number {
  if (!shells) return 0;
  let n = 0;
  for (const j of shells) if (counts(j, foregroundOnly)) n++;
  return n;
}

/**
 * Waiting for a foreground command for more than FOREGROUND_WAIT_MS? ('working' status with a
 * long Bash still without a result: the agent is stopped watching the command run.)
 */
export function foregroundWaiting(shells: readonly ShellJob[] | undefined, now: number): boolean {
  const j = oldestShell(shells, true);
  return !!j && now - j.startedAt > FOREGROUND_WAIT_MS;
}

/**
 * Start (epoch ms) of an agent's wait in 'shell' mode: the oldest shell (in the foreground,
 * when the status is 'working'); with none listed, the moment the status changed.
 */
export function shellWaitSince(a: { status: AgentStatus; shells?: ShellJob[]; statusSince: number }): number {
  const j = oldestShell(a.shells, a.status !== 'shell');
  return j ? j.startedAt : a.statusSince;
}

/** Speech bubble label: that of the oldest shell or a generic text. */
export function shellLabel(a: { status: AgentStatus; shells?: ShellJob[] }): string {
  const fg = a.status !== 'shell';
  const j = oldestShell(a.shells, fg);
  const label = j?.label?.trim();
  if (label) return label;
  if (j?.kind === 'monitor') return tr('Monitoring a process');
  return fg ? tr('Terminal command') : tr('Background command');
}

/**
 * The agent's most recent 'ShellDone' Activity (the current one or among the recent ones — another
 * activity may have arrived in the same snapshot), or null. No allocation.
 */
export function latestShellDone(a: { activity?: Activity; recent?: readonly Activity[] }): Activity | null {
  let best: Activity | null = a.activity?.tool === SHELL_DONE_TOOL ? a.activity : null;
  const recent = a.recent;
  if (recent) {
    for (let i = recent.length - 1; i >= 0; i--) {
      const r = recent[i];
      if (r.tool === SHELL_DONE_TOOL && (!best || r.at > best.at)) best = r;
    }
  }
  return best;
}

// ------------------------------------------------------------------ time and speech bubble

/** Wait time as text: "45 s", "3 min", "1 h 05". */
export function formatShellAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h} h ${mm < 10 ? '0' : ''}${mm}`;
}

/**
 * Key that changes exactly when the text of `formatShellAge` changes (the speech bubble only rebuilds
 * the string when it needs to — seconds in the first minute, then minutes).
 */
export function shellAgeKey(ms: number): number {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? s : 60 + Math.floor(s / 60);
}

/** Speech bubble text (the ⏳ is the speech bubble's icon). */
export function shellBubbleText(label: string, ageMs: number): string {
  return `${label} · ${formatShellAge(ageMs)}`;
}

/**
 * Opacity (0..1) of the wait speech bubble in 'important' mode, `ms` after entering the state:
 * visible for the first SHELL_BUBBLE_ENTER_MS; then for SHELL_BUBBLE_SHOW_MS every
 * SHELL_BUBBLE_EVERY_MS (shifted by `offsetMs`, so the speech bubbles of several characters don't blink together).
 */
export function shellBubbleAlpha(ms: number, offsetMs = 0): number {
  if (ms < 0) return 0;
  if (ms < SHELL_BUBBLE_ENTER_MS) return windowAlpha(ms, SHELL_BUBBLE_ENTER_MS);
  const off = ((offsetMs % SHELL_BUBBLE_EVERY_MS) + SHELL_BUBBLE_EVERY_MS) % SHELL_BUBBLE_EVERY_MS;
  // first repeat ~30 s after entering
  const t = ms - SHELL_BUBBLE_EVERY_MS - off;
  if (t < 0) return 0;
  const inCycle = t % SHELL_BUBBLE_EVERY_MS;
  return inCycle < SHELL_BUBBLE_SHOW_MS ? windowAlpha(inCycle, SHELL_BUBBLE_SHOW_MS) : 0;
}

function windowAlpha(t: number, len: number): number {
  return Math.max(0, Math.min(1, t / BUBBLE_FADE_IN_MS, (len - t) / BUBBLE_FADE_OUT_MS));
}

// ------------------------------------------------------------------ spins and yawns

/** Pseudorandom number in [0, 1), deterministic by (seed, index, salt). */
export function unitHash(seed: number, k: number, salt: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca77)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Phase (0..1) of a periodic event at `ageMs`, or -1 outside it. Events of `durMs` start at
 * `fromMs + firstMs` and repeat with intervals drawn (by seed) in [gapMin, gapMax],
 * only while `ageMs < toMs`. No allocation (short loop: dozens of iterations in the worst case).
 */
export function periodicPhase(ageMs: number, fromMs: number, toMs: number, firstMs: number, gapMin: number, gapMax: number, durMs: number, seed: number, salt: number): number {
  if (ageMs < fromMs || ageMs >= toMs) return -1;
  let t = fromMs + firstMs;
  for (let k = 0; t <= ageMs && k < 10_000; k++) {
    if (ageMs < t + durMs) return (ageMs - t) / durMs;
    t += gapMin + unitHash(seed, k, salt) * (gapMax - gapMin);
  }
  return -1;
}

/** Phase (0..1) of the spin in the chair, or -1. Spins every 15–25 s in the 'restless' stage. */
export function spinPhase(ageMs: number, seed: number): number {
  return periodicPhase(ageMs, SHELL_RESTLESS_MS, SHELL_COBWEB_MS, SPIN_FIRST_MS, SPIN_GAP_MIN_MS, SPIN_GAP_MAX_MS, SPIN_MS, seed, 1);
}

/** Phase (0..1) of a yawn, or -1. Now and then in the 'cobweb' stage. */
export function yawnPhase(ageMs: number, seed: number): number {
  return periodicPhase(ageMs, SHELL_COBWEB_MS, SHELL_NAP_MS, YAWN_FIRST_MS, YAWN_GAP_MIN_MS, YAWN_GAP_MAX_MS, YAWN_MS, seed, 2);
}

/** Clockwise seen from above: north -> east -> south -> west. */
const CLOCKWISE: readonly Dir[] = ['up', 'right', 'down', 'left'];

/**
 * Direction during the spin (phase 0..1): one full turn clockwise, a quarter at a time,
 * ending back at `base`.
 */
export function spinDir(phase: number, base: Dir): Dir {
  if (phase < 0) return base;
  const i = CLOCKWISE.indexOf(base);
  const q = Math.min(3, Math.floor(phase * 4));
  return CLOCKWISE[(i + q + 1) % 4];
}
