// Steps of a character's action queue. Created in planning (never per frame).
import type { Dir, HeldItem, IconName, Pose } from '../../art/api';
import type { Gathering } from '../social/gathering';

export type Step =
  /** Walks (or runs) to the tile (tx, ty); then, optionally, to the fine position (fx, fy) and turns to `dir`. */
  | { t: 'go'; tx: number; ty: number; run?: boolean; fx?: number; fy?: number; dir?: Dir; held?: HeldItem; path?: number[]; i?: number; fine?: boolean }
  /** Snaps into the spot (seat or use point). Requires being on the approach tile. */
  | { t: 'enter'; spot: string }
  /** Leaves the current spot back to the approach tile (getting up). */
  | { t: 'exit' }
  /** Stays in a pose for a while. */
  | { t: 'act'; pose: Pose; ms: number; held?: HeldItem; dir?: Dir; icon?: IconName; machine?: string; seated?: boolean }
  /** Waits for a condition (or the maximum time), in a pose. */
  | { t: 'until'; cond: () => boolean; minMs: number; maxMs: number; pose?: Pose; held?: HeldItem; dir?: Dir }
  /** Appears inside the elevator and leaves to the tile in front. */
  | { t: 'elevOut'; elev: number; phase: number }
  /** Enters the elevator and disappears. */
  | { t: 'elevIn'; elev: number; phase: number }
  /** Uses the bathroom stall: goes in, disappears, door closes; then comes out. */
  | { t: 'stall'; spot: string; ms: number; phase: number }
  /** Turns the room light on/off at the switch (needs to be at the switch's spot). */
  | { t: 'switch'; room: string; on: boolean; phase: number; onlyIfLast?: boolean }
  /** Takes part in a hangout (TV, game, chat...) until it ends; the pose comes from the director (social/social.ts). */
  | { t: 'gather'; g: Gathering }
  /** Immediate side effect. */
  | { t: 'do'; fn: () => void }
  /** Removes the character from the world. */
  | { t: 'remove' };
