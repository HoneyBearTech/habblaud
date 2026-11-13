// Greetings in the city (Phase 5): the wheel with the 10 greetings from the list (ids only; the text comes out
// translated for the reader), who receives it (the player selected in the card or the nearest one), the speech
// bubbles over the heads for 5 s and the limit on this side (1 every 3 s, 20 per minute: the server closes the
// connection after 3 refusals in a minute).
// The models are pure (tested); the wheel is DOM (`ui-city-wheel*` classes from city/social.css).
import { tr } from '../../../../shared/i18n';
import { GREETINGS, greetingIcon, greetingLabel } from '../../../../shared/world/social-labels';
import { GREETING_IDS, type GreetingId } from '../../../../shared/world/protocol';
import { h, setText } from '../../ui/dom';

/** How long the speech bubble stays over the head (the server also says 5 s; the clock here is the one that counts). */
export const BALLOON_MS = 5_000;
/** How far (tiles) the wheel looks for someone to greet. */
export const GREET_RANGE = 12;
/** Whoever greeted me less than this ago is the first in the wheel (to reply). */
export const REPLY_WINDOW_MS = 10_000;

/** The order of the wheel (the protocol's). */
export const WHEEL: readonly GreetingId[] = GREETING_IDS;

/** Position of each item in the wheel: the first on top, clockwise (px from the center). */
export function wheelLayout(n: number, radius: number): Array<{ x: number; y: number; angle: number }> {
  const out: Array<{ x: number; y: number; angle: number }> = [];
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2;
    out.push({ x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius), angle });
  }
  return out;
}

/** Shortcut key of each wheel item: 1–9 and 0 (the 10th). */
export function wheelKey(i: number): string {
  return i === 9 ? '0' : String(i + 1);
}

/** The wheel item of a key ("1".."9", "0"), or -1. */
export function wheelIndexOfKey(key: string): number {
  if (!/^[0-9]$/.test(key)) return -1;
  const i = key === '0' ? 9 : Number(key) - 1;
  return i < WHEEL.length ? i : -1;
}

/**
 * Who the greeting goes to: whoever just greeted me (to reply), the player selected in the card (if still here) or
 * the nearest one within `range` tiles. null = nobody.
 */
export function pickGreetTarget(
  me: { x: number; y: number },
  players: Iterable<{ id: string; x: number; y: number }>,
  opts: { selected?: string | null; replyTo?: string | null; range?: number } = {},
): string | null {
  const range = opts.range ?? GREET_RANGE;
  let best: string | null = null;
  let bestD = range * range;
  const ids = new Set<string>();
  for (const p of players) {
    ids.add(p.id);
    const d = (p.x - me.x) ** 2 + (p.y - me.y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = p.id;
    }
  }
  if (opts.replyTo && ids.has(opts.replyTo)) return opts.replyTo;
  if (opts.selected && ids.has(opts.selected)) return opts.selected;
  return best;
}

/** The active speech bubbles (per player), each for BALLOON_MS from when it arrived here. */
export class BalloonBook {
  private readonly map = new Map<string, { id: GreetingId; at: number }>();

  add(playerId: string, greetingId: GreetingId, now: number): void {
    this.map.set(playerId, { id: greetingId, at: now });
  }

  /** A player's speech bubble now (`t`: 0..1 of its lifetime), or null. */
  get(playerId: string, now: number): { id: GreetingId; t: number; age: number } | null {
    const b = this.map.get(playerId);
    if (!b) return null;
    const age = now - b.at;
    if (age >= BALLOON_MS || age < 0) {
      this.map.delete(playerId);
      return null;
    }
    return { id: b.id, t: age / BALLOON_MS, age };
  }

  get size(): number {
    return this.map.size;
  }

  ids(): string[] {
    return [...this.map.keys()];
  }

  clear(): void {
    this.map.clear();
  }
}

/** Limit on this side: at most one every `gapMs` and `perMinute` per minute. */
export class RateGate {
  private readonly times: number[] = [];

  constructor(
    private readonly perMinute: number,
    private readonly gapMs = 0,
  ) {}

  /** How long is left (ms) until it can again; 0 = it can now. */
  wait(now: number): number {
    while (this.times.length && now - this.times[0]! >= 60_000) this.times.shift();
    const last = this.times[this.times.length - 1];
    let w = last === undefined ? 0 : Math.max(0, last + this.gapMs - now);
    if (this.times.length >= this.perMinute) w = Math.max(w, this.times[0]! + 60_000 - now);
    return w;
  }

  /** Tries to use: true (and counts) if it can now. */
  take(now: number): boolean {
    if (this.wait(now) > 0) return false;
    this.times.push(now);
    return true;
  }
}

/** A reply that matches the greeting received (suggestion: the first in the wheel when replying). */
export function suggestedReply(got: GreetingId): GreetingId {
  switch (got) {
    case 'hello':
    case 'wave':
      return 'nice_to_meet';
    case 'nice_building':
    case 'congrats':
    case 'clap':
    case 'good_luck':
      return 'thanks';
    case 'coffee':
      return 'coffee';
    case 'bye':
      return 'bye';
    case 'thanks':
      return 'clap';
    case 'nice_to_meet':
      return 'wave';
  }
}

// ====================================================================== DOM: the wheel

export interface WheelTarget {
  id: string;
  name: string;
}

/**
 * The greeting wheel: 10 buttons in a circle around my character, the name of who receives it in the middle and an
 * arrow pointing at the person. Click, touch or 1–9/0 choose; arrows change the highlight; Esc closes.
 */
export class GreetingWheel {
  readonly el: HTMLElement;
  private readonly ring: HTMLElement;
  private readonly center: HTMLElement;
  private readonly to: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private target: WheelTarget | null = null;
  private focused = 0;
  private pick: ((id: GreetingId) => void) | null = null;

  constructor() {
    this.to = h('strong', { class: 'ui-city-wheel__to' });
    this.hint = h('span', { class: 'ui-city-wheel__hint' });
    this.arrow = h('span', { class: 'ui-city-wheel__arrow', attrs: { 'aria-hidden': 'true' } });
    this.center = h('div', { class: 'ui-city-wheel__center' }, h('span', { class: 'ui-city-wheel__label', text: tr('Greet') }), this.to, this.hint);
    this.ring = h('div', { class: 'ui-city-wheel__ring', role: 'menu', attrs: { 'aria-label': tr('Greetings') } });
    const layout = wheelLayout(WHEEL.length, 96);
    WHEEL.forEach((id, i) => {
      const p = layout[i]!;
      const b = h(
        'button',
        {
          class: 'ui-city-wheel__item',
          type: 'button',
          role: 'menuitem',
          style: `--x:${p.x}px;--y:${p.y}px;--i:${i}`,
          attrs: { 'aria-label': `${greetingLabel(id)} (${wheelKey(i)})`, 'data-greeting': id },
          on: {
            click: () => this.choose(i),
            pointerenter: () => this.focus(i, false),
            focus: () => this.focus(i, false),
          },
        },
        h('span', { class: 'ui-city-wheel__emoji', text: greetingIcon(id), attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'ui-city-wheel__key', text: wheelKey(i), attrs: { 'aria-hidden': 'true' } }),
      );
      this.buttons.push(b);
      this.ring.append(b);
    });
    this.el = h('div', { class: 'ui-city-wheel', hidden: true }, this.arrow, this.ring, this.center);
    this.el.addEventListener('pointerdown', (e) => {
      // touching outside the buttons closes
      if (e.target === this.el) this.close();
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  get targetId(): string | null {
    return this.target?.id ?? null;
  }

  /** Opens centered on `at` (window px), pointing at `toward` (window px, optional). */
  show(target: WheelTarget, at: { x: number; y: number }, toward: { x: number; y: number } | null, first: GreetingId | null, onPick: (id: GreetingId) => void): void {
    this.target = target;
    this.pick = onPick;
    setText(this.to, target.name);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = 132;
    const x = Math.max(r, Math.min(vw - r, at.x));
    const y = Math.max(r + 40, Math.min(vh - r, at.y));
    this.el.style.setProperty('--cx', `${Math.round(x)}px`);
    this.el.style.setProperty('--cy', `${Math.round(y)}px`);
    if (toward) {
      const a = Math.atan2(toward.y - y, toward.x - x);
      this.arrow.style.setProperty('--a', `${a}rad`);
      this.arrow.hidden = Math.hypot(toward.x - x, toward.y - y) < 30;
    } else this.arrow.hidden = true;
    this.el.hidden = false;
    this.el.classList.remove('is-in');
    void this.el.offsetWidth;
    this.el.classList.add('is-in');
    this.focus(Math.max(0, first ? WHEEL.indexOf(first) : 0), true);
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.target = null;
    this.pick = null;
  }

  /** Key with the wheel open: true if it used it. */
  key(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    const i = wheelIndexOfKey(e.key);
    if (i >= 0) {
      this.choose(i);
      return true;
    }
    switch (e.key) {
      case 'Escape':
      case 'g':
      case 'G':
        this.close();
        return true;
      case 'ArrowRight':
      case 'ArrowDown':
        this.focus((this.focused + 1) % WHEEL.length, true);
        return true;
      case 'ArrowLeft':
      case 'ArrowUp':
        this.focus((this.focused + WHEEL.length - 1) % WHEEL.length, true);
        return true;
      case 'Enter':
      case ' ':
        this.choose(this.focused);
        return true;
    }
    return false;
  }

  private focus(i: number, move: boolean): void {
    this.focused = i;
    this.buttons.forEach((b, k) => b.classList.toggle('is-focus', k === i));
    const id = WHEEL[i]!;
    setText(this.hint, `${GREETINGS[id].icon} ${greetingLabel(id)}`);
    if (move) this.buttons[i]?.focus({ preventScroll: true });
  }

  private choose(i: number): void {
    const id = WHEEL[i];
    const cb = this.pick;
    if (!id || !cb) return;
    this.buttons[i]?.classList.add('is-picked');
    setTimeout(() => this.buttons[i]?.classList.remove('is-picked'), 300);
    this.close();
    cb(id);
  }
}
