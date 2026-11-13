// Habblaud World › Blocked (Phase 5): who this account blocked (from the person's card, in the city) and
// "Unblock" (POST /api/world/unblock, through the connection with the world). Blocking works both ways: one doesn't
// see the other on the street, in the buildings, in the greetings and in the stamps. The list comes from /v1/me (the
// status reread when the screen opens).
import { tr } from '../../../../shared/i18n';
import type { WorldBlockedPlayer, WorldClient } from '../../net/world';
import { h, setAttr, setHidden, setText } from '../dom';
import { worldErrorText } from './world-model';

export interface BlockedHost {
  readonly client: WorldClient | null;
  /** The list from the last status (undefined before it arrives). */
  list(): WorldBlockedPlayer[] | undefined;
  /** Rereads the status with /v1/me (the list may have changed in the city). */
  refresh(): Promise<void>;
  /** The screen is still this one (a response that arrives after leaving it doesn't touch anything). */
  current(): boolean;
  announce(text: string): void;
}

/** The screen: the header (with the back button) comes from settings-world.ts. */
export function buildBlocked(head: HTMLElement, host: BlockedHost): { el: HTMLElement; sync(): void } {
  const list = h('ul', { class: 'ui-world__blocked' });
  const note = h('p', { class: 'ui-set__hint', text: tr('Loading…') });
  const error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
  /** Ids unblocked on this screen (they leave the list right away, before the new status). */
  const gone = new Set<string>();
  let key = '';
  let loaded = false;

  const row = (p: WorldBlockedPlayer): HTMLElement => {
    const btn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Unblock'), attrs: { 'aria-label': tr('Unblock {0}', [p.name]) } });
    btn.addEventListener('click', async () => {
      const client = host.client;
      if (!client || btn.disabled) return;
      btn.disabled = true;
      setAttr(btn, 'aria-busy', 'true');
      setHidden(error, true);
      const r = await client.unblock(p.id);
      if (!host.current()) return;
      btn.disabled = false;
      setAttr(btn, 'aria-busy', null);
      if (!r.ok) {
        setText(error, worldErrorText(r.code, 'unblock'));
        setHidden(error, false);
        return;
      }
      gone.add(p.id);
      host.announce(tr('{0} unblocked.', [p.name]));
      sync();
    });
    return h(
      'li',
      { class: 'ui-set ui-world__blocked-row' },
      h('div', { class: 'ui-set__text' }, h('span', { class: 'ui-world__blocked-name' }, h('span', { text: '🚫', attrs: { 'aria-hidden': 'true' } }), ` ${p.name}`)),
      btn,
    );
  };

  const sync = () => {
    const all = host.list();
    const items = (all ?? []).filter((p) => !gone.has(p.id));
    const k = `${loaded}|${all ? 'y' : 'n'}|${items.map((p) => `${p.id}:${p.name}`).join(',')}`;
    if (k === key) return;
    key = k;
    if (!all && !loaded) {
      setText(note, tr('Loading…'));
      setHidden(note, false);
      list.replaceChildren();
      return;
    }
    setText(note, items.length ? '' : tr('Nobody blocked.'));
    setHidden(note, items.length > 0);
    list.replaceChildren(...items.map(row));
  };

  void host.refresh().finally(() => {
    if (!host.current()) return;
    loaded = true;
    sync();
  });
  sync();
  return {
    el: h(
      'div',
      { class: 'ui-world__stack' },
      head,
      h('p', { class: 'ui-set__hint', text: tr("People you block don't see you and you don't see them: on the street, in buildings, in greetings and in stamps. To block someone, open their card in the city.") }),
      note,
      list,
      error,
    ),
    sync,
  };
}
