// Back to the city on the same page (Office → World): the player comes back EXACTLY where they were. The world server
// keeps the last position per account (on `view.off` or on a drop) and sends the initial `pos` equal to it; the scene
// keeps, on hiding, the camera, the zoom and where my character was, and on reopening decides with the `pos` that
// arrives:
//   * the same place: nothing changes (neither the character nor the camera; the city from before stays on the screen
//     until the new snapshot);
//   * another place: the character and camera go straight there, without animating a "teleport", with the same zoom;
//   * nothing saved (the first time, or it closed before spawning): the usual spawn.

/** Where the city was on hiding: camera (world px), zoom, whether it followed the character and where they were (tiles). */
export interface CityResume {
  camX: number;
  camY: number;
  zoom: number;
  following: boolean;
  me: { x: number; y: number } | null;
}

/** How far (tiles) the server's `pos` is "the same place": the position goes up rounded and the last step may be missing. */
export const RESUME_SAME_TILES = 0.6;

export type ResumePlacement = 'keep' | 'snap' | 'fresh';

/** What to do with the initial `pos` on reopening the scene (see the top of the file). */
export function resumePlacement(resume: CityResume | null, pos: { x: number; y: number } | null): ResumePlacement {
  if (!resume?.me || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return 'fresh';
  return Math.hypot(pos.x - resume.me.x, pos.y - resume.me.y) <= RESUME_SAME_TILES ? 'keep' : 'snap';
}
