// City cards: the building's (on hover or click) and the player's (on click; the profile arrives over the
// stream). The models are pure (tested); the DOM part uses the `ui-city-card*` classes from ui/styles.css.
import { avatarCanvas } from '../../art';
import { hash32 } from '../../../../shared/hash';
import { intlLocale, tr } from '../../../../shared/i18n';
import { introLabel } from '../../../../shared/world/intro';
import type { WorldBuildingPublic, WorldPlayerPublic } from '../../../../shared/world/protocol';
import { TRAITS, isTraitId } from '../../../../shared/world/traits';
import { h, setHidden, setText } from '../../ui/dom';

/** The card shows the number of floors up to this; above it, "24+". (The facade draws up to 12 and puts "+N".) */
export const CARD_MAX_FLOORS = 24;

/** Flag (emoji) of an ISO-2 code; empty if the code doesn't have the format. */
export function flagEmoji(code: string | undefined | null): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  const up = code.toUpperCase();
  return String.fromCodePoint(0x1f1e6 + up.charCodeAt(0) - 65, 0x1f1e6 + up.charCodeAt(1) - 65);
}

/** Country name in the viewer's language (the code, if the browser doesn't know it). */
export function countryName(code: string | undefined | null): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  try {
    return new Intl.DisplayNames([intlLocale()], { type: 'region' }).of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** "2026-10" → "October 2026" (local month, no time zone: day 1 at 0 h in the viewer's time). */
export function monthLabel(ym: string | undefined): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym ?? '');
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return '';
  try {
    return new Intl.DateTimeFormat(intlLocale(), { month: 'long', year: 'numeric' }).format(new Date(y, mo - 1, 1));
  } catch {
    return `${m[2]}/${m[1]}`;
  }
}

/** "1 floor", "7 floors", "24+ floors", "ground floor only". */
export function floorsLabel(floors: number): string {
  const n = Number.isFinite(floors) ? Math.max(0, Math.floor(floors)) : 0;
  if (n === 0) return tr('ground floor only');
  if (n > CARD_MAX_FLOORS) return tr('{0} floors', [`${CARD_MAX_FLOORS}+`]);
  return n === 1 ? tr('1 floor') : tr('{0} floors', [n]);
}

export function likesLabel(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return v === 1 ? tr('1 like') : tr('{0} likes', [v.toLocaleString(intlLocale())]);
}

export interface BuildingCardModel {
  owner: string;
  flag: string;
  country: string;
  online: boolean;
  state: string;
  floors: string;
  /** null = discreet mode (the owner doesn't show the agents). */
  agents: { working: number; waiting: number; idle: number } | null;
  likes: string;
  since: string;
  closed: boolean;
  mine: boolean;
}

export function buildingCardModel(b: WorldBuildingPublic, myBuildingId: string | null = null): BuildingCardModel {
  const online = b.state === 'online';
  return {
    owner: b.owner.name,
    flag: flagEmoji(b.owner.country),
    country: countryName(b.owner.country),
    online,
    state: online ? tr('Lights on') : tr('Lights off'),
    floors: floorsLabel(b.floors),
    agents: b.agents ? { working: b.agents.working, waiting: b.agents.waiting, idle: b.agents.idle } : null,
    likes: likesLabel(b.likes),
    since: monthLabel(b.sinceMonth),
    closed: b.closed === true,
    mine: !!myBuildingId && b.id === myBuildingId,
  };
}

export interface PlayerCardModel {
  name: string;
  flag: string;
  country: string;
  traits: { emoji: string; label: string; desc: string }[];
  intro: string;
  likes: string;
  /** The player's building, if they have one and the city knows it. */
  building: { id: string; floors: string; online: boolean } | null;
  hasBuilding: boolean;
}

export function playerCardModel(p: WorldPlayerPublic, building: WorldBuildingPublic | undefined): PlayerCardModel {
  return {
    name: p.name,
    flag: flagEmoji(p.country),
    country: countryName(p.country),
    traits: (p.traits ?? []).filter(isTraitId).map((t) => ({ emoji: TRAITS[t].emoji, label: TRAITS[t].label, desc: TRAITS[t].desc })),
    intro: p.intro ? introLabel(p.intro) : '',
    likes: likesLabel(p.likesReceived),
    building: building ? { id: building.id, floors: floorsLabel(building.floors), online: building.state === 'online' } : null,
    hasBuilding: !!p.buildingId,
  };
}

// ====================================================================== DOM

export interface CardActions {
  /** Takes the camera to the building (not the player). */
  showBuilding(id: string): void;
  /** How far the top bar goes (px): the card stays below it. */
  topInset(): number;
  /** (Optional) Enter the building: mine, from anywhere ("See it as others do"). */
  enter?(id: string): void;
  /**
   * What else goes at the end of the card (Phase 5, city/social.ts: like, knock, greet, block, report): an
   * element that updates itself, put back each time the card is rebuilt.
   */
  extras?(kind: 'building' | 'player', id: string): HTMLElement | null;
}

/** The two cards (one at a time), positioned near the point on the screen. */
export class CityCards {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly flag: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly body: HTMLElement;
  private readonly avatar: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  /** What is open: ('building'|'player', id) and whether it was by click (stays) or by hover (goes away on leave). */
  kind: 'building' | 'player' | null = null;
  id: string | null = null;
  pinned = false;
  private sig = '';

  constructor(private readonly actions: CardActions) {
    this.avatar = h('span', { class: 'ui-city-card__avatar', hidden: true, attrs: { 'aria-hidden': 'true' } });
    this.flag = h('span', { class: 'ui-city-card__flag', attrs: { 'aria-hidden': 'true' } });
    this.title = h('strong', { class: 'ui-city-card__title' });
    this.sub = h('div', { class: 'ui-city-card__sub' });
    this.body = h('div', { class: 'ui-city-card__body' });
    this.closeBtn = h('button', { class: 'ui-city-card__close', type: 'button', title: tr('Close'), attrs: { 'aria-label': tr('Close') }, text: '×', on: { click: () => this.hide() } });
    this.el = h(
      'section',
      { class: 'ui-city-card', hidden: true, role: 'dialog', attrs: { 'aria-live': 'polite', 'aria-label': tr('Card') } },
      h('div', { class: 'ui-city-card__head' }, this.avatar, h('div', { class: 'ui-city-card__names' }, h('div', { class: 'ui-city-card__line' }, this.flag, this.title), this.sub), this.closeBtn),
      this.body,
    );
  }

  get open(): boolean {
    return this.kind !== null;
  }

  hide(): void {
    this.kind = null;
    this.id = null;
    this.pinned = false;
    this.sig = '';
    this.el.hidden = true;
  }

  showBuilding(b: WorldBuildingPublic, myBuildingId: string | null, at: { x: number; y: number }, pinned: boolean): void {
    const m = buildingCardModel(b, myBuildingId);
    const sig = `b|${b.id}|${JSON.stringify(m)}`;
    this.kind = 'building';
    this.id = b.id;
    this.pinned = pinned || (this.pinned && this.id === b.id);
    this.el.classList.toggle('is-pinned', this.pinned);
    if (sig !== this.sig) {
      this.sig = sig;
      setHidden(this.avatar, true);
      setText(this.flag, m.flag);
      this.flag.title = m.country;
      setText(this.title, m.owner);
      setText(this.sub, [m.mine ? tr('Your building') : '', m.country].filter(Boolean).join(' · '));
      this.el.classList.toggle('is-online', m.online);
      const rows: HTMLElement[] = [];
      rows.push(h('div', { class: 'ui-city-card__row' }, h('span', { class: `ui-city-card__dot ${m.online ? 'is-on' : 'is-off'}` }), h('span', { text: m.state }), h('span', { class: 'ui-city-card__sep', text: '·' }), h('span', { text: m.floors })));
      if (m.agents) {
        rows.push(
          h(
            'div',
            { class: 'ui-city-card__agents' },
            h('span', { class: 'ui-city-card__agent is-working', title: tr('Agents working') }, h('b', { text: String(m.agents.working) }), ` ${tr('working')}`),
            h('span', { class: 'ui-city-card__agent is-waiting', title: tr('Agents waiting for the owner') }, h('b', { text: String(m.agents.waiting) }), ` ${tr('waiting')}`),
            h('span', { class: 'ui-city-card__agent is-idle', title: tr('Idle agents') }, h('b', { text: String(m.agents.idle) }), ` ${tr('idle')}`),
          ),
        );
      } else rows.push(h('div', { class: 'ui-city-card__muted', text: tr("Discreet mode: the owner doesn't show the agents.") }));
      if (m.closed) rows.push(h('div', { class: 'ui-city-card__muted', text: `🔒 ${tr('Closed to visitors')}` }));
      rows.push(h('div', { class: 'ui-city-card__row ui-city-card__foot' }, h('span', { text: `❤️ ${m.likes}` }), m.since ? h('span', { class: 'ui-city-card__since', text: tr('In the world since {0}', [m.since]) }) : null));
      // my building: enter from anywhere and see what the others see inside
      const enter = this.actions.enter;
      if (m.mine && enter) {
        const id = b.id;
        rows.push(h('button', { class: 'ui-city-card__link', type: 'button', text: `👁 ${tr('See it as others do')}`, on: { click: () => enter(id) } }));
      }
      const extra = this.actions.extras?.('building', b.id);
      if (extra) rows.push(extra);
      this.body.replaceChildren(...rows);
    }
    this.place(at);
    this.el.hidden = false;
  }

  showPlayer(p: WorldPlayerPublic, building: WorldBuildingPublic | undefined, at: { x: number; y: number } | null): void {
    const m = playerCardModel(p, building);
    const sig = `p|${p.id}|${JSON.stringify(m)}|${JSON.stringify(p.parts)}`;
    this.kind = 'player';
    this.id = p.id;
    this.pinned = true;
    this.el.classList.add('is-pinned');
    this.el.classList.remove('is-online');
    if (sig !== this.sig) {
      this.sig = sig;
      setHidden(this.avatar, false);
      try {
        const c = avatarCanvas(hash32(p.id), { look: p.look, parts: p.parts, scale: 2 });
        c.className = 'ui-city-card__avatar-img';
        this.avatar.replaceChildren(c);
      } catch {
        this.avatar.replaceChildren();
      }
      setText(this.flag, m.flag);
      this.flag.title = m.country;
      setText(this.title, m.name);
      setText(this.sub, m.country);
      const rows: HTMLElement[] = [];
      if (m.intro) rows.push(h('div', { class: 'ui-city-card__intro', text: `“${m.intro}”` }));
      if (m.traits.length) rows.push(h('div', { class: 'ui-city-card__traits' }, ...m.traits.map((t) => h('span', { class: 'ui-trait', title: t.desc, text: `${t.emoji} ${t.label}` }))));
      const foot = h('div', { class: 'ui-city-card__row ui-city-card__foot' }, h('span', { text: `❤️ ${tr('{0} received', [m.likes])}` }));
      if (m.building) {
        const b = m.building;
        foot.append(
          h('button', { class: 'ui-city-card__link', type: 'button', text: `🏢 ${tr('See the building')} (${b.floors})`, on: { click: () => this.actions.showBuilding(b.id) } }),
        );
      } else foot.append(h('span', { class: 'ui-city-card__muted', text: m.hasBuilding ? tr('Building far from here') : tr('No building yet') }));
      rows.push(foot);
      const extra = this.actions.extras?.('player', p.id);
      if (extra) rows.push(extra);
      this.body.replaceChildren(...rows);
    }
    if (at) this.place(at);
    this.el.hidden = false;
  }

  /** Near the point (window px), without leaving the screen. */
  private place(at: { x: number; y: number }): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = this.el.offsetWidth || 260;
    const hgt = this.el.offsetHeight || 140;
    if (vw <= 520) {
      // phone: the card stays at the bottom, from side to side
      this.el.style.transform = '';
      this.el.classList.add('is-docked');
      return;
    }
    this.el.classList.remove('is-docked');
    const top = this.actions.topInset() + 8;
    let x = at.x + 16;
    let y = at.y - hgt - 12;
    if (x + w > vw - 8) x = at.x - w - 16;
    if (y < top) y = at.y + 18;
    x = Math.max(8, Math.min(vw - w - 8, x));
    y = Math.max(top, Math.min(vh - hgt - 8, y));
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
