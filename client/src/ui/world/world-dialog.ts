// The Habblaud World window: a modal <dialog> (top layer, darkened background, trapped focus, Esc closes) with its
// own button in the top bar (city icon, only with the world server configured) and also opened by the chip
// "in the world" / "paused" next to the version, by the launch popups ("Create account", "Create character") and
// by the "While you were away" notice. The content is the WorldSettingsGroup (settings-world.ts): account,
// waitlist, character, "Your building", devices, account and data, blocked and sign out. The header carries the
// building in pixels, the title, the account state chip and the close button; the body scrolls. The theme hint in
// Settings › Appearance still comes from the group (themeNote/onThemePicked), which is why the group lives here
// and the popover only gets the two.
//
// Two modals at the same time (the waitlist popup right after sign-up, or "See what was sent"):
// showModal() stacks on the top layer, Esc closes only the top one and focus returns to this window when it closes.
import { tr } from '../../../../shared/i18n';
import type { WorldSource, WorldThemeChoice } from '../../net/world';
import type { UiComponent, UiContext } from '../context';
import { h, iconButton, setHidden } from '../dom';
import { ICONS } from '../icons';
import { WorldSettingsGroup, worldGate } from './settings-world';
import { WORLD_BUILDING_ICON } from './world-popups';
import { worldSectionMode, type WorldScreen } from './world-model';

const TITLE_ID = 'ui-world-dialog-title';

/** What Settings needs from World: the theme hint in Appearance and sending the chosen theme to the building. */
export interface WorldThemeLink {
  readonly themeNote: HTMLElement;
  onThemePicked(theme: WorldThemeChoice): Promise<void>;
}

export class WorldDialog implements UiComponent, WorldThemeLink {
  readonly el: HTMLDialogElement;
  private readonly group: WorldSettingsGroup;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  /** Who had the focus before opening (the bar button, the chip…): goes back there on closing. */
  private opener: HTMLElement | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    /** The top bar button: goes away without the world server configured and gets aria-expanded. */
    private readonly button: HTMLElement,
  ) {
    this.group = new WorldSettingsGroup(ctx, src);
    const badge = h('span', { class: 'ui-world-dialog__badge', attrs: { 'aria-hidden': 'true' } });
    badge.innerHTML = WORLD_BUILDING_ICON;
    this.title = h('h2', { class: 'ui-world-dialog__title', text: tr('Habblaud World'), tabIndex: -1, attrs: { id: TITLE_ID } });
    const close = iconButton(ICONS.close, tr('Close (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.body = h('div', { class: 'ui-world-dialog__body' }, this.group.el);
    this.el = h(
      'dialog',
      // `aria-modal` only while open (closed, the <dialog> stays in the DOM and can't look like an open modal).
      { class: 'ui-world-dialog', attrs: { 'aria-labelledby': TITLE_ID } },
      h('div', { class: 'ui-world-dialog__head' }, badge, h('div', { class: 'ui-world-dialog__heading' }, this.title, this.group.chip), close),
      this.body,
    );
    // A click on the backdrop (outside the content) closes it.
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    // The keyboard stays inside the window: the office shortcuts don't fire underneath. Esc closes (the modal <dialog>
    // already does that; without showModal, we do it here) and doesn't reach the shortcuts.
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Escape' || typeof this.el.showModal === 'function') return;
      e.preventDefault();
      this.close();
    });
    this.el.addEventListener('close', () => this.onClosed());
  }

  get themeNote(): HTMLElement {
    return this.group.themeNote;
  }

  onThemePicked(theme: WorldThemeChoice): Promise<void> {
    return this.group.onThemePicked(theme);
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  /** Opens (if closed) and, with `screen`, goes to the requested screen (the sign-up, the character, the building…). */
  show(screen?: WorldScreen, opener?: HTMLElement | null): void {
    this.group.show(screen);
    if (this.el.open) return;
    this.opener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (typeof this.el.showModal === 'function') this.el.showModal();
    else this.el.setAttribute('open', '');
    this.el.setAttribute('aria-modal', 'true');
    this.button.setAttribute('aria-expanded', 'true');
    this.body.scrollTop = 0;
    // The focus starts on the title (the screen reader announces the window); screens with a form go to the first field.
    this.title.focus({ preventScroll: true });
    this.ctx.invalidate();
  }

  toggle(opener?: HTMLElement | null): void {
    if (this.el.open) this.close();
    else this.show(undefined, opener);
  }

  close(): void {
    if (!this.el.open) return;
    this.el.removeAttribute('aria-modal');
    if (typeof this.el.close === 'function') this.el.close();
    else {
      this.el.removeAttribute('open');
      this.onClosed();
    }
  }

  private onClosed(): void {
    this.button.setAttribute('aria-expanded', 'false');
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.opener = null;
    this.ctx.invalidate();
  }

  render(): void {
    // Without the world server configured (or through the phone port), not even the button shows.
    const hidden = worldSectionMode(this.src.meta(), worldGate(this.ctx, this.src)) === 'hidden';
    setHidden(this.button, hidden);
    if (hidden && this.el.open) this.close();
    this.group.render(this.el.open);
  }
}
