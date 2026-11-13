// State of a project room in the world: life cycle (construction/dismantling) and light.
import type { RoomInfo } from '../../../../shared/types';
import type { RoomTheme } from '../../art/api';
import { BUILD_MS, DISMANTLE_MS } from '../constants';
import type { AreaLayout } from '../layout/types';
import { lightLevel } from './behavior';

/**
 * - building: construction animation;
 * - ready: room ready;
 * - dismantling: dismantling animation;
 * - gone: dismantled (will be removed).
 */
export type RoomPhase = 'building' | 'ready' | 'dismantling' | 'gone';

export class RoomState {
  info: RoomInfo;
  /** Seed the theme and layout were generated with (fixed since creation, even if info.seed changes). */
  readonly seed: number;
  /** Slot in the building chosen by the client (no gaps; see Sim.compact). May differ from info.slot. */
  slot: number;
  theme: RoomTheme;
  layout: AreaLayout;
  phase: RoomPhase;
  phaseAt: number;
  listed = true;
  unlistedAt = 0;
  lightOn: boolean;
  lightAt = -1e9;
  /** Character that took charge of the switch (turn on when arriving / turn off when leaving). */
  switchClaim: string | null = null;
  /** When all the dismantling conditions became true (0 = they aren't). */
  readyToDismantleAt = 0;
  /** Accounts present (for the little dots on the sign), updated by the world. */
  accounts: string[] = [];
  /** Items of the kanban board. */
  board: { status: 'pending' | 'in_progress' | 'completed' }[] = [];
  /** Increments when something in the static cache changes (name, theme). */
  version = 0;
  /**
   * Old address of a room that moved: it stays in place only until whoever was in it leaves and it
   * goes dark and is dismantled. Nobody belongs to it and it doesn't appear in the snapshot.
   */
  ghost = false;

  constructor(info: RoomInfo, theme: RoomTheme, layout: AreaLayout, phase: RoomPhase, now: number, lit: boolean, slot: number) {
    this.info = info;
    this.seed = info.seed;
    this.slot = slot;
    this.theme = theme;
    this.layout = layout;
    this.phase = phase;
    this.phaseAt = now;
    this.lightOn = lit;
    if (lit) this.lightAt = now - 10_000;
  }

  get id(): string {
    return this.info.id;
  }

  /** Progress of the current phase's animation (0..1). */
  progress(now: number): number {
    if (this.phase === 'building') return Math.min(1, (now - this.phaseAt) / BUILD_MS);
    if (this.phase === 'dismantling') return Math.min(1, (now - this.phaseAt) / DISMANTLE_MS);
    if (this.phase === 'ready') return 1;
    return 0;
  }

  /** Occupies the grid (walkable) and is drawn. */
  get present(): boolean {
    return this.phase === 'building' || this.phase === 'ready' || this.phase === 'dismantling';
  }

  setPhase(phase: RoomPhase, now: number): void {
    this.phase = phase;
    this.phaseAt = now;
  }

  /** Reverts a dismantling in progress to construction, continuing from the equivalent visual point. */
  rebuild(now: number): void {
    if (this.phase === 'dismantling') {
      const p = this.progress(now);
      this.phase = 'building';
      this.phaseAt = now - (1 - p) * BUILD_MS;
    } else if (this.phase === 'gone') {
      this.setPhase('building', now);
    }
  }

  setLight(on: boolean, now: number): void {
    if (this.lightOn === on) return;
    this.lightOn = on;
    this.lightAt = now;
  }

  light(now: number): number {
    return lightLevel(this.lightOn, now - this.lightAt);
  }
}
