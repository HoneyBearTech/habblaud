// World button in the top bar: swaps the office for the Habblaud World city and back (Office button or Esc).
// It only shows with the scene available: `meta.world.scene.available` from the local server (in demo mode, with the
// account approved), from the page on the computer itself (never through the phone port) and never in the timelapse.
// The scene itself is mounted by app.ts (CitySceneHost); here are the button, the
// interface's "in the city" state (`is-city` class on #ui) and the way there and back.
import { tr } from '../../../../shared/i18n';
import type { WorldSource } from '../../net/world';
import type { Selection } from '../../world/api';
import type { UiComponent, UiContext } from '../context';
import { h, setAttr, setHidden, setText, setTitle } from '../dom';
import { ICONS } from '../icons';
import { worldGate } from './settings-world';
import { worldSectionMode, type WorldGate } from './world-model';

/** What the interface needs from the city scene (implemented in app.ts, with the scene loaded on demand). */
export interface CitySceneHost {
  readonly open: boolean;
  /** Shows the city (loads the scene the first time) and hides the office. */
  show(): Promise<void>;
  hide(): void;
  zoomBy(factor: number): void;
  recenter(): void;
  /** Esc: closes whatever is open in the city (card); false = nothing to close. */
  escape(): boolean;
  /** "See it as others do": enters your own building (with the city already open). */
  visitOwn?(): void;
}

/**
 * Is the World scene available? `meta.world.scene.available` (from the local server: account approved, character
 * created, the terminal lock and no ban or suspension; in demo mode, the FakeWorldApi's; without the field, no) and the
 * page opened from the computer itself: the snapshot also goes to the phone, but the scene's routes don't (like the
 * World section and the bar badge).
 */
export function citySceneAvailable(src: WorldSource, gate: WorldGate): boolean {
  const meta = src.meta();
  return meta?.scene?.available === true && worldSectionMode(meta, gate) === 'active';
}

export class SceneSwitch implements UiComponent {
  readonly button: HTMLButtonElement;
  private readonly icon: HTMLElement;
  private readonly label: HTMLElement;
  private busy = false;
  private autoOpen: boolean;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    private readonly host: CitySceneHost,
    private readonly onChange: () => void,
  ) {
    this.icon = h('span', { class: 'ui-scene-btn__icon', attrs: { 'aria-hidden': 'true' } });
    this.label = h('span', { class: 'ui-scene-btn__label' });
    this.button = h('button', { class: 'ui-scene-btn', type: 'button', hidden: true, on: { click: () => void this.toggle() } }, this.icon, this.label);
    // ?scene=city: opens straight in the city (demo mode screenshots)
    this.autoOpen = typeof location !== 'undefined' && new URLSearchParams(location.search).get('scene') === 'city';
  }

  get inCity(): boolean {
    return this.host.open;
  }

  private available(): boolean {
    return citySceneAvailable(this.src, worldGate(this.ctx, this.src)) && !this.ctx.store.replaying && !this.ctx.isTimelapseOpen();
  }

  async toggle(): Promise<void> {
    if (this.host.open) this.close();
    else await this.open();
  }

  async open(): Promise<void> {
    if (this.busy || this.host.open || !this.available()) return;
    this.busy = true;
    try {
      // the drawer and the terminal close: in the city there is no selected agent
      if (this.ctx.selection()) this.ctx.select(null);
      await this.host.show();
      this.ctx.announce(tr("You're in the Habblaud World city. Esc goes back to the office."));
    } catch (err) {
      console.error('[ui] the city did not open', err);
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  /** "See it as others do": opens the city (if needed) and enters your own building. */
  async visitOwn(): Promise<void> {
    if (!this.host.open) await this.open();
    if (this.host.open) this.host.visitOwn?.();
  }

  close(): void {
    if (!this.host.open) return;
    this.host.hide();
    this.ctx.announce(tr('Back at the office.'));
    this.onChange();
  }

  /**
   * Picking an agent or room with the city open (notice, Reply, notification, delivery) goes back to the office: in the
   * city the drawer and the terminal stay hidden. Called by `ctx.select` before measuring the free area and focusing.
   */
  leaveFor(sel: Selection): void {
    if (sel) this.close();
  }

  render(): void {
    const ok = this.available();
    // the scene went down (account, timelapse): back to the office
    if (!ok && this.host.open) this.close();
    setHidden(this.button, !ok && !this.host.open);
    const city = this.host.open;
    this.icon.innerHTML = city ? ICONS.office : ICONS.city;
    setText(this.label, city ? tr('Office') : tr('World'));
    const title = city ? tr('Back to the office (Esc)') : tr('World: walk around the Habblaud World city');
    setTitle(this.button, title);
    setAttr(this.button, 'aria-label', title);
    setAttr(this.button, 'aria-pressed', String(city));
    this.button.classList.toggle('is-city', city);
    if (this.autoOpen && ok) {
      this.autoOpen = false;
      void this.open();
    }
  }
}
