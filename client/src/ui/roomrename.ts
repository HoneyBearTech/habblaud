// Rename a room (right-click on the room, in the side list or in the office): a floating field near the click.
// The name stays on the server (POST /api/rooms/rename, model/room-aliases.ts) and applies to all tabs; empty
// goes back to the folder name. Enter saves, Esc cancels, clicking outside saves. The room drawer also has a
// pencil next to the name.
import { isDemoId } from '../../../shared/timeline';
import type { UiContext } from './context';
import { h, setText } from './dom';
import { access } from '../net/access';
import { tr } from '../../../shared/i18n';

const NAME_MAX = 40;

/**
 * Can this room be renamed from here? The server refuses demo rooms, anyone who didn't open Habblaud from their own
 * computer and Habblaud exposed on the network (without the terminal lock); in mock mode and in the timelapse there
 * is no server to save to.
 */
export function canRenameRoom(ctx: UiContext, roomId: string): boolean {
  return (
    !!ctx.renameRoom &&
    !isDemoId(roomId) &&
    !ctx.store.mock &&
    !ctx.store.replaying &&
    !!ctx.store.snapshot?.meta.terminal &&
    access().local
  );
}

async function renameRequest(id: string, name: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/rooms/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name }) });
  } catch {
    throw new Error(tr("Habblaud didn't respond"));
  }
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? tr('error {0}', [res.status]));
}

export class RoomRenamer {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private hint: HTMLElement;
  private roomId: string | null = null;
  private original = '';
  private onDocDown = (e: PointerEvent) => {
    if (!this.el.contains(e.target as Node)) void this.commit();
  };

  constructor(private ctx: UiContext) {
    this.input = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: NAME_MAX, 'aria-label': tr('Room name'), spellcheck: 'false' } });
    this.hint = h('p', { class: 'ui-rename__hint' });
    this.el = h('div', { class: 'ui-rename', role: 'dialog', hidden: true, attrs: { 'aria-label': tr('Rename room') } }, h('label', { class: 'ui-rename__label', text: tr('Rename room') }), this.input, this.hint);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  /** Opens the field for the room, near the point (window px). */
  open(roomId: string, at: { x: number; y: number }): void {
    const room = this.ctx.store.room(roomId);
    if (!room) return;
    this.roomId = roomId;
    this.original = room.name;
    this.input.value = room.name;
    setText(this.hint, tr('Enter saves · Esc cancels · empty resets to “{0}”', [room.path.split(/[\\/]/).filter(Boolean).pop() ?? room.path]));
    this.hint.classList.remove('is-error');
    this.el.hidden = false;
    const w = this.el.offsetWidth || 260;
    const hgt = this.el.offsetHeight || 80;
    this.el.style.left = `${Math.max(8, Math.min(at.x, innerWidth - w - 8))}px`;
    this.el.style.top = `${Math.max(8, Math.min(at.y, innerHeight - hgt - 8))}px`;
    this.input.focus();
    this.input.select();
    document.addEventListener('pointerdown', this.onDocDown, true);
  }

  close(): void {
    this.el.hidden = true;
    this.roomId = null;
    document.removeEventListener('pointerdown', this.onDocDown, true);
  }

  private async commit(): Promise<void> {
    const id = this.roomId;
    const name = this.input.value.trim();
    if (!id || name === this.original) return this.close();
    try {
      await renameRequest(id, name);
      if (this.roomId === id) this.close();
      this.ctx.announce(name ? tr('Room renamed to {0}.', [name]) : tr('The room is back to the folder name.'));
    } catch (err) {
      // stays open with the reason (e.g. demo room, Habblaud opened from another address)
      setText(this.hint, tr("Didn't work: {0}", [(err as Error).message]));
      this.hint.classList.add('is-error');
    }
  }
}
