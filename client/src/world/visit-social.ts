// The light social side INSIDE someone's building (Phase 5), hooked up by the Visit scene (world/visit/index.ts):
//   const social = mountVisitSocial(painel, { building, mine, send, toast });
//   ...on each stream message: if (social.message(msg)) return;   // like.update and the like and stamp notices
//   ...with the new building (`building`, or the `building` of a patch): social.sync();  on leaving: social.destroy();
// - Like button (❤️ Like / 💔 Unlike, with the total): from inside the building the server accepts it without the
//   door distance.
// - "Leave a stamp": the front desk's 8 stamps (ids only), one per building per day (UTC day, like the server). What
//   was left today stays in this browser (localStorage) for the button and for the reception board; the server keeps
//   only the count per stamp and day, never who stamped.
// - The reception's stamp board is drawn by the Visit scene: `stampBoard` gives the model (where each stamp goes on
//   the board, tilt and icon), pure and deterministic; the owner viewing their own building can pass the stamps from
//   "While you were away" for the agents to "find" at the reception.
import { tr } from '../../../shared/i18n';
import type { WorldSceneCommand } from '../../../shared/world/api';
import type { StampId, WorldBuildingPublic } from '../../../shared/world/protocol';
import { STAMPS, STAMP_IDS, stampIcon, stampLabel } from '../../../shared/world/social-labels';
import { h, setHidden } from '../ui/dom';
import { RateGate } from './city/greetings';
import { browserStorage } from './social/wallet';
import './visit-social.css';

/** A world notice right after a command is the reply to it. */
const PENDING_MS = 4_000;

/** The UTC day ("2026-10-15") of an instant: the stamp is one per building per UTC day. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Key of this browser's stamp for today in a building. */
export function stampKey(buildingId: string): string {
  return `habblaud:world-stamp:${buildingId}`;
}

/** The stamp this browser left today in the building (or null), read from what was saved. */
export function stampedToday(raw: string | null, day: string): StampId | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { day?: unknown; stampId?: unknown };
    return v.day === day && (STAMP_IDS as readonly unknown[]).includes(v.stampId) ? (v.stampId as StampId) : null;
  } catch {
    return null;
  }
}

/**
 * The notice that replies to a stamp: `stamped` = it counted (the server confirms; the toast already went out
 * when stamping), `already_done` = there was already one today, any other (far away, building that left,
 * limit) = it did not stick.
 */
export function stampReply(text: string): 'ok' | 'already' | 'failed' {
  return text === 'stamped' ? 'ok' : text === 'already_done' ? 'already' : 'failed';
}

/** A stamp on the reception board: position (0..1 of the board), tilt (degrees), icon and label. */
export interface StampPin {
  stampId: StampId;
  icon: string;
  label: string;
  count: number;
  /** This browser's stamp (highlight). */
  mine: boolean;
  x: number;
  y: number;
  rot: number;
}

/**
 * The reception stamp board (pure model): up to `max` stamps in a 4-column grid, each with a jitter
 * and a tilt fixed by the seed (the same board on every drawn frame), mine first.
 */
export function stampBoard(entries: ReadonlyArray<{ stampId: StampId; count?: number; mine?: boolean }>, seed = 0, max = 8): StampPin[] {
  const sorted = [...entries].filter((e) => (STAMP_IDS as readonly string[]).includes(e.stampId)).sort((a, b) => Number(!!b.mine) - Number(!!a.mine) || (b.count ?? 1) - (a.count ?? 1));
  const cols = 4;
  const rows = Math.max(1, Math.ceil(Math.min(max, sorted.length) / cols));
  let r = (seed ^ 0x9e3779b9) >>> 0;
  const rnd = () => {
    r = (Math.imul(r ^ (r >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    return ((r ^ (r >>> 13)) >>> 0) / 4294967296;
  };
  return sorted.slice(0, max).map((e, i) => {
    const c = i % cols;
    const row = Math.floor(i / cols);
    return {
      stampId: e.stampId,
      icon: stampIcon(e.stampId),
      label: stampLabel(e.stampId),
      count: Math.max(1, e.count ?? 1),
      mine: !!e.mine,
      x: (c + 0.5 + (rnd() - 0.5) * 0.35) / cols,
      y: (row + 0.5 + (rnd() - 0.5) * 0.3) / rows,
      rot: Math.round((rnd() - 0.5) * 24),
    };
  });
}

// ====================================================================== DOM

export interface VisitSocialApi {
  /** The visited building (the `building` of the interior), or null outside a building. */
  building(): WorldBuildingPublic | null;
  /** It is my building (the owner seeing it as others see it): no like and no stamp. */
  mine(): boolean;
  /** Sends commands over the scene's stream (like, unlike, stamp). */
  send(cmds: WorldSceneCommand[]): void;
  /** The scene's quick notice. */
  toast(text: string): void;
  now?(): number;
}

export interface VisitSocialHandle {
  readonly el: HTMLElement;
  /** A world message: the building's `like.update` and the notices that reply to a like or stamp. true = handled. */
  message(msg: unknown): boolean;
  /** Another building (or the same one, updated): rebuilds the buttons. */
  sync(): void;
  /** The stamp this browser left today in this building (the reception board). */
  stampedToday(): StampId | null;
  destroy(): void;
}

/** Mounts Like and "Leave a stamp" in `container` (the Visit scene's panel). */
export function mountVisitSocial(container: HTMLElement, api: VisitSocialApi): VisitSocialHandle {
  const now = () => api.now?.() ?? Date.now();
  // localStorage (without ui/prefs.ts: the Visit scene imports nothing from the office interface)
  const store = browserStorage();
  let likes = 0;
  let liked = false;
  let id = '';
  let pending: { kind: 'like' | 'stamp'; at: number; stampId?: StampId } | null = null;
  // a little below the server's 10 per minute (commands go out in batches and can arrive closer together)
  const likeGate = new RateGate(9, 400);

  const likeBtn = h('button', { class: 'ui-visit-social__like', type: 'button', on: { click: () => toggleLike() } });
  const stampBtn = h('button', { class: 'ui-visit-social__stamp', type: 'button', attrs: { 'aria-expanded': 'false' }, on: { click: () => togglePicker() } });
  const picker = h(
    'div',
    { class: 'ui-visit-social__picker', role: 'group', hidden: true, attrs: { 'aria-label': tr('Pick a stamp for the front desk') } },
    h('p', { class: 'ui-visit-social__hint', text: tr('One stamp per building per day. The owner sees how many of each they got, never who left them.') }),
    h(
      'div',
      { class: 'ui-visit-social__grid' },
      ...STAMP_IDS.map((s) =>
        h(
          'button',
          { class: 'ui-visit-social__choice', type: 'button', title: stampLabel(s), attrs: { 'data-stamp': s }, on: { click: () => stamp(s) } },
          h('span', { class: 'ui-visit-social__choice-icon', text: STAMPS[s].icon, attrs: { 'aria-hidden': 'true' } }),
          h('span', { text: stampLabel(s) }),
        ),
      ),
    ),
  );
  const el = h('div', { class: 'ui-visit-social' }, h('div', { class: 'ui-visit-social__row' }, likeBtn, stampBtn), picker);
  container.append(el);

  const today = (): StampId | null => (id ? stampedToday(readStamp(id), utcDay(now())) : null);
  function readStamp(bid: string): string | null {
    try {
      return store?.getItem(stampKey(bid)) ?? null;
    } catch {
      return null;
    }
  }
  function writeStamp(bid: string, s: StampId | null): void {
    try {
      if (s) store?.setItem(stampKey(bid), JSON.stringify({ day: utcDay(now()), stampId: s }));
      else store?.removeItem?.(stampKey(bid));
    } catch {
      // no localStorage: lasts only until the page is closed
    }
  }

  function paint(): void {
    const b = api.building();
    const mine = api.mine();
    setHidden(el, !b || mine);
    if (!b) return;
    likeBtn.replaceChildren(h('span', { text: liked ? '💔' : '❤️', attrs: { 'aria-hidden': 'true' } }), ` ${liked ? tr('Unlike') : tr('Like')}`, h('b', { class: 'ui-visit-social__count', text: String(likes) }));
    likeBtn.classList.toggle('is-liked', liked);
    likeBtn.title = liked ? tr("Undo the like on {0}'s building", [b.owner.name]) : tr("Like {0}'s building", [b.owner.name]);
    const s = today();
    stampBtn.disabled = !!s;
    stampBtn.replaceChildren(h('span', { text: s ? stampIcon(s) : '📮', attrs: { 'aria-hidden': 'true' } }), ` ${s ? tr("Today's stamp: {0}", [stampLabel(s)]) : tr('Leave a stamp')}`);
    if (s) closePicker();
  }

  function sync(): void {
    const b = api.building();
    if (b && b.id !== id) {
      id = b.id;
      closePicker();
    }
    if (b) {
      likes = b.likes;
      liked = b.likedByMe === true;
    }
    paint();
  }

  function toggleLike(): void {
    const b = api.building();
    if (!b || api.mine()) return;
    if (!likeGate.take(now())) {
      api.toast(tr('Easy on the likes: wait a moment.'));
      return;
    }
    const on = !liked;
    api.send([{ t: on ? 'like' : 'unlike', buildingId: b.id }]);
    pending = { kind: 'like', at: now() };
    // optimistic: the like.update confirms (or corrects)
    liked = on;
    likes = Math.max(0, likes + (on ? 1 : -1));
    likeBtn.classList.remove('is-pop');
    void likeBtn.offsetWidth;
    if (on) likeBtn.classList.add('is-pop');
    paint();
  }

  function closePicker(): void {
    setHidden(picker, true);
    stampBtn.setAttribute('aria-expanded', 'false');
  }

  function togglePicker(): void {
    if (today()) return;
    const open = picker.hidden;
    setHidden(picker, !open);
    stampBtn.setAttribute('aria-expanded', String(open));
  }

  function stamp(s: StampId): void {
    const b = api.building();
    if (!b || api.mine() || today()) return;
    api.send([{ t: 'stamp', buildingId: b.id, stampId: s }]);
    pending = { kind: 'stamp', at: now(), stampId: s };
    writeStamp(b.id, s);
    api.toast(`${stampIcon(s)} ${tr('Stamp left at the front desk: {0}', [stampLabel(s)])}`);
    paint();
  }

  function message(msg: unknown): boolean {
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as Record<string, unknown>;
    if (m.t === 'like.update' && m.buildingId === id && typeof m.likes === 'number') {
      likes = m.likes;
      liked = m.likedByMe === true;
      if (pending?.kind === 'like') pending = null;
      paint();
      return false;
    }
    if (m.t !== 'notice' || typeof m.text !== 'string' || !pending || now() - pending.at > PENDING_MS) return false;
    const p = pending;
    pending = null;
    if (p.kind === 'stamp') {
      const reply = stampReply(m.text);
      if (reply === 'ok') return true;
      if (reply === 'already') {
        api.toast(tr('You already left a stamp here today.'));
        return true;
      }
      // it did not count (far away, building that left): the stamp did not stick
      writeStamp(id, null);
      paint();
      api.toast(m.text === 'too_far' ? tr('Go into the building or get closer to the door to stamp.') : tr("The stamp wasn't left. Try again."));
      return true;
    }
    if (m.text === 'daily_limit') api.toast(tr("You've used today's 50 likes. More tomorrow!"));
    else if (m.text === 'rate_limited') api.toast(tr('Easy on the likes: wait a moment.'));
    else return false;
    // the like did not count: goes back to what it was
    liked = !liked;
    likes = Math.max(0, likes + (liked ? 1 : -1));
    paint();
    return true;
  }

  sync();
  return {
    el,
    message,
    sync,
    stampedToday: today,
    destroy: () => el.remove(),
  };
}

/** The stamp's short text for the board (screen readers and tooltips). */
export function stampPinTitle(p: StampPin): string {
  return p.count > 1 ? `${p.label} ×${p.count}` : p.label;
}
