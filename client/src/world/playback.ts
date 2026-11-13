// Timelapse in the world: during the replay the simulation runs on its own clock, sped up by a
// moderate animation factor (walking 1 h of recording in 6 s would not fit in real steps), while the
// snapshots arrive on the recording's clock, much faster. For the thresholds that compare the snapshot
// with "now" (nap after 10 min idle, stages of the shell wait, long command in the
// foreground), the ages are preserved: the snapshot's times are shifted to the world's
// clock at the moment it is applied (rebaseSnapshot).
import type { OfficeSnapshot } from '../../../shared/types';

/**
 * Animation factor of the world for a playback speed: ~square root of the speed, between 1 and 16
 * (60× -> 6, 180× -> 10, 600× -> 16). Above that the characters would only teleport.
 */
export function animScale(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  return Math.min(16, Math.max(1, Math.round(Math.sqrt(speed) * 0.75)));
}

/**
 * Shifts to the world's clock the snapshot times that the world compares with "now":
 * `statusSince` and the start of the shells. The activities stay as they are (the world only compares
 * them with each other).
 */
export function rebaseSnapshot(snap: OfficeSnapshot, delta: number): OfficeSnapshot {
  if (!delta) return snap;
  return {
    ...snap,
    serverTime: snap.serverTime + delta,
    agents: snap.agents.map((a) => {
      const out = { ...a, statusSince: a.statusSince + delta };
      if (a.shells) out.shells = a.shells.map((j) => ({ ...j, startedAt: j.startedAt + delta }));
      return out;
    }),
  };
}
