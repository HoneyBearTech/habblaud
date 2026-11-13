// CONTRACT of the world (office canvas) consumed by the UI (client/src/ui/**).
// Implementation: client/src/world/index.ts -> createWorld().
// Rule: changes here must be ADDITIVE.

export type Selection = { type: 'agent'; id: string } | { type: 'room'; id: string } | null;

export interface WorldOptions {
  /** Show labels with the characters' names. */
  showNames: boolean;
  /** Activity speech bubbles: all, only important ones (needs you, selected, recent changes) or none. */
  bubbles: 'all' | 'important' | 'none';
  /** Frequency of strolls around the office when the agents are idle. */
  liveliness: 'calm' | 'normal' | 'lively';
  /** Camera follows the selected agent. */
  followSelected: boolean;
  /** Day/night cycle by local time (windows, lighting). */
  dayNight: boolean;
  /** (Optional, additive) Day/night cycle: automatic, always day or always night. Overrides `dayNight`. */
  daylight?: DaylightMode;
  /** Visual theme: automatic (follows the calendar; see seasonalThemeFor), none, Christmas or Halloween. */
  theme?: OfficeTheme;
}

/** Theme the renderer draws: the original office ('none') or one of the seasonal ones. */
export type SeasonalTheme = 'none' | 'christmas' | 'halloween';
export type OfficeTheme = 'auto' | SeasonalTheme;

/**
 * Theme drawn on a date (local time). In automatic: Halloween from October 1 to 31, Christmas from November 1 to
 * December 26 and, the rest of the year, the original office.
 */
export function seasonalThemeFor(theme: OfficeTheme | undefined, date: Date): SeasonalTheme {
  if (theme && theme !== 'auto') return theme;
  const month = date.getMonth();
  if (month === 9) return 'halloween';
  if (month === 10 || (month === 11 && date.getDate() <= 26)) return 'christmas';
  return 'none';
}

/** Day/night cycle: follows local time, or fixes day or night. */
export type DaylightMode = 'auto' | 'day' | 'night';

/** Ambient sounds the world suggests (who plays them, and whether they play, is up to the UI). */
export type SoundCueKind = 'keys' | 'elevator' | 'pingpong' | 'table' | 'arcade';

export interface SoundCue {
  kind: SoundCueKind;
  /** 0..1: proximity (zoom, off screen...). */
  gain: number;
  /** -1 (left) .. 1 (right): position on the screen. */
  pan: number;
  /** Keyboard: how many keys in the burst. */
  count?: number;
}

export interface WorldApi {
  /** Selects (or clears) an agent/room. `focus` moves the camera to it. */
  select(sel: Selection, opts?: { focus?: boolean }): void;
  getSelection(): Selection;
  /** Fired when the selection changes (by a click on the canvas or by select()). */
  onSelect(cb: (sel: Selection) => void): () => void;
  /** Agent under the cursor (for UI tooltips). */
  onHover(cb: (agentId: string | null) => void): () => void;
  focusAgent(id: string, opts?: { follow?: boolean }): void;
  focusRoom(id: string): void;
  /** Frames the whole building. */
  overview(): void;
  zoomBy(factor: number): void;
  getOptions(): WorldOptions;
  setOptions(o: Partial<WorldOptions>): void;
  /** Screen position (CSS px, relative to the viewport) just above the character's head, or null if not visible. */
  screenPositionOf(agentId: string): { x: number; y: number } | null;
  /**
   * (Optional, additive) Area of the screen covered by UI panels, in CSS px. The world then frames
   * (overview) and centers (focusAgent/focusRoom/follow) within the free area.
   */
  setViewInsets?(insets: Partial<ViewInsets>): void;
  /**
   * (Optional, additive) Social life of an agent present in the office: personality, coin
   * wallet, friendships/rivalries with whoever is there now and the hangout it is part of. null if it is not there.
   */
  social?(agentId: string): AgentSocial | null;
  /** (Optional, additive) Right click on an office room: room id and the click point (window px). */
  onRoomContextMenu?(cb: (roomId: string, at: { x: number; y: number }) => void): () => void;
  /** (Optional, additive) Social events (matches and bets) for the feed. */
  onSocialEvent?(cb: (e: SocialEvent) => void): () => void;
  /**
   * (Optional, additive) Timelapse: with `p`, the world starts drawing the replayed day (clock and animation
   * factor from `p`); `null` goes back to live. Each call restarts the world from scratch (nobody walks to the desk:
   * everyone already appears in place), so call it on entering, on jumping to another point and on leaving; the next
   * store snapshot is applied as the initial load.
   */
  setPlayback?(p: WorldPlayback | null): void;
  /** (Optional, additive) Ambient sounds: keyboard of whoever is working in view, elevator, hangouts. */
  onSound?(cb: (cue: SoundCue) => void): () => void;
  /**
   * (Optional, additive) Office off screen (the city scene is open): stops the drawing and the camera
   * keyboard; on return, the simulation advances the time that passed (as with the tab in the background).
   */
  setSuspended?(suspended: boolean): void;
  destroy(): void;
}

/** Timelapse clocks (see world/playback.ts). */
export interface WorldPlayback {
  /** Replayed instant (epoch ms): time of the sky, of the lighting and of the wall clock. */
  clock(): number;
  /** Animation factor (1 = real time; 0 = paused). */
  scale(): number;
}

export interface AgentSocial {
  traits: { emoji: string; label: string; desc: string }[];
  /** Catchphrase ("Done and done!"). */
  catchphrase: string;
  /** Coin balance (🪙). */
  coins: number;
  /** How much it has already earned working (starting balance + tasks + requests + deliveries). */
  earned: number;
  wins: number;
  losses: number;
  /** Coworkers present with whom it has a friendship or rivalry; `record` = [wins, losses] against that coworker. */
  bonds: { id: string; name: string; kind: 'amizade' | 'rivalidade'; record: [number, number] | null }[];
  /** What it is doing in a hangout now ("📺 Watching soccer on TV with Rafaela"), or null. */
  doing: string | null;
  /** Statement: most recent transactions first. */
  ledger: { at: number; delta: number; icon: string; text: string }[];
}

/** Resolved match/bet (becomes a line of the feed). */
export interface SocialEvent {
  id: string;
  at: number;
  icon: string;
  /** Protagonist (who won). */
  agentId: string;
  /** Text without the protagonist's name: "won 🪙10 from Caio at rock-paper-scissors". */
  text: string;
  /** Where it happened ("Lounge", "Kitchen"...). */
  place: string;
}

/** Viewport margins covered by the UI (CSS px). */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_WORLD_OPTIONS: WorldOptions = {
  showNames: true,
  bubbles: 'important',
  liveliness: 'normal',
  followSelected: false,
  dayNight: true,
  theme: 'auto',
};
