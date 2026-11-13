// Context shared among the interface components.
import type { AccountInfo, AgentInfo } from '../../../shared/types';
import type { OfficeStore } from '../net/store';
import type { Selection, WorldApi } from '../world/api';
import type { UiPrefs } from './prefs';

export interface UiComponent {
  /** Called at most once per frame, when something changed (snapshot, selection, clock...). */
  render(): void;
}

export type PanelName = 'sidebar' | 'feed';

/**
 * A single terminal window, per agent: the interactive one when the session runs inside Habblaud (pty); otherwise
 * the read-only one (with "Take over here" to become interactive). Mounted in ui/index.ts.
 */
export interface TerminalRouter {
  /** Agent with the terminal open (either of the two), or null. */
  readonly openAgentId: string | null;
  open(agentId: string, opener?: HTMLElement | null): void;
  toggle(agentId: string, opener?: HTMLElement | null): void;
  /** The terminal of this agent would be the interactive one. */
  interactive(agentId: string): boolean;
  /** Some terminal can be opened now (local access, outside the timelapse). */
  readonly available: boolean;
  /** Interactive terminal on (open new sessions, take over, end). */
  readonly interactiveEnabled: boolean;
  /** New Claude Code session in the folder, opened in the interactive terminal. */
  newSession(cwd: string, account?: string): Promise<void>;
}

export type HelpSection = 'usage' | 'codex';

export interface UiContext {
  readonly store: OfficeStore;
  /** Terminal window (set after the panels exist). */
  terminals?: TerminalRouter;
  readonly world: WorldApi;
  readonly root: HTMLElement;
  readonly prefs: Readonly<UiPrefs>;
  updatePrefs(patch: Partial<UiPrefs>): void;
  /** Server clock (corrects the difference between the local clock and the server's). */
  now(): number;
  account(id: string): AccountInfo | undefined;
  agent(id: string): AgentInfo | undefined;
  selection(): Selection;
  /**
   * Selects in the world (the UI syncs through onSelect). With `focus`, the camera goes to the target inside the
   * free area (outside the panels) and the focus is redone when panels open/close, until the user moves the camera.
   */
  select(sel: Selection, opts?: { focus?: boolean }): void;
  /** Takes the camera to the current selection again (Center button). */
  focusSelection(): void;
  /** Camera commands from the UI buttons/shortcuts (they cancel the held focus). */
  camera(action: 'overview' | 'zoomIn' | 'zoomOut'): void;
  /** Schedules a render on the next frame. */
  invalidate(): void;
  /** Opens/closes a panel (no argument: toggles). */
  togglePanel(name: PanelName, open?: boolean): void;
  isPanelOpen(name: PanelName): boolean;
  /** Narrow screen: panels become overlaid drawers. */
  isNarrow(): boolean;
  /** Announces a text to screen readers. */
  announce(text: string): void;
  focusSearch(): void;
  /** Opens the help; with `section`, scrolls to it (e.g. "usage" = Accounts and usage). */
  openHelp(section?: HelpSection): void;
  toggleSettings(): void;
  /** Opens/closes the Habblaud World window (the top bar button; ui/world/world-dialog.ts). */
  toggleWorld(): void;
  /** Opens the room rename field near the point (window px); right click on the room (ui/roomrename.ts). */
  renameRoom?(roomId: string, at: { x: number; y: number }): void;
  /**
   * (Optional) "See it as others do": opens the Habblaud World city and enters your own building (the Visit scene).
   * Only exists with the World scene mounted (app.ts).
   */
  visitOwnBuilding?(): void;
  /** Opens the settings at the "About" section (version in use and new version). */
  openAbout(): void;
  /** Opens/closes the day timelapse (ui/timelapse.ts). */
  toggleTimelapse(): void;
  isTimelapseOpen(): boolean;
}
