// New agent (button in the top bar): starts a Claude Code session in the background on the Mac, in the chosen folder
// and with the request (POST /api/spawn; server/spawn/spawn.ts). The folders are the computer's recent projects
// (GET /api/spawn/folders: session history + rooms), to choose with one tap; "Other folder" accepts a typed path.
// The request can carry attachments (POST /api/spawn/attachments, one per file, before the request) and be
// dictated (ui/dictation.ts, local Whisper on the Mac). A folder that Claude Code doesn't know falls to the app
// (Enter there).
import { tr } from '../../../shared/i18n';
import { isDemoId } from '../../../shared/timeline';
import type { OfficeSnapshot } from '../../../shared/types';
import type { UiContext } from './context';
import { DictationButton, dictationAvailable, insertDictation } from './dictation';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

export const SPAWN_PROMPT_MAX = 8_000;
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const POLL_MS = 700;
/**
 * How long the page waits for the request to open: more than the server takes to give up (30 s queue + `claude --bg`
 * and `open`, 50 s; server/spawn/spawn.ts), so it never says "didn't confirm" about something that will still open.
 */
const WAIT_MS = 90_000;
const LAST_FOLDER_KEY = 'habblaud.spawn.folder';

interface SpawnInfo {
  id: string;
  status: 'queued' | 'sent' | 'opened' | 'failed';
  error?: string;
  how?: 'cli' | 'app';
  note?: string;
}

export interface FolderOption {
  path: string;
  name: string;
  lastAt: number;
  sessions?: number;
}

/** Room folders, from most recent to oldest (fallback when the server doesn't send the list). */
export function spawnFolders(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'> | null | undefined): string[] {
  if (!snap) return [];
  const last = new Map<string, number>();
  for (const a of snap.agents) last.set(a.roomId, Math.max(last.get(a.roomId) ?? 0, a.lastEventAt ?? 0));
  const paths = [...snap.rooms]
    .filter((r) => !isDemoId(r.id) && /^(\/|[A-Za-z]:[\\/])/.test(r.path ?? ''))
    .sort((a, b) => (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0))
    .map((r) => r.path);
  return [...new Set(paths)];
}

/** Short path for the list: the home folder becomes "~". */
export function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i, '~');
}

/** "now", "5 min", "3 h", "2 d" (empty with no time). */
export function ago(at: number, now = Date.now()): string {
  if (!at) return '';
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return tr('now');
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error(tr("couldn't read the file")));
    r.readAsDataURL(file);
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error(tr("Habblaud didn't respond"));
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? tr('error {0}', [res.status]));
  return body;
}

function readPref(): string {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) ?? '';
  } catch {
    return '';
  }
}

function writePref(path: string): void {
  try {
    localStorage.setItem(LAST_FOLDER_KEY, path);
  } catch {
    // no storage: it just doesn't remember
  }
}

interface PendingFile {
  file: File;
  url?: string;
  el: HTMLElement;
}

export class SpawnPanel {
  readonly el: HTMLElement;
  private readonly folderList: HTMLElement;
  private readonly otherBtn: HTMLButtonElement;
  private readonly folder: HTMLInputElement;
  private readonly prompt: HTMLTextAreaElement;
  private readonly fileInput: HTMLInputElement;
  private readonly fileList: HTMLElement;
  private readonly dictate: DictationButton;
  private readonly submitBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private anchor?: HTMLElement;
  private busy = false;
  private folders: FolderOption[] = [];
  private selected = '';
  private typing = false;
  private files: PendingFile[] = [];

  constructor(private readonly ctx: UiContext) {
    this.folderList = h('div', { class: 'ui-spawn__folders', role: 'radiogroup', attrs: { 'aria-label': tr('Recent projects') } });
    this.otherBtn = h('button', { class: 'ui-spawn__other', type: 'button', on: { click: () => this.showOther(true) } }, tr('+ Other folder'));
    this.folder = h('input', {
      class: 'ui-rename__input ui-spawn__path',
      type: 'text',
      hidden: true,
      attrs: { id: 'ui-spawn-folder', placeholder: '/Users/you/project', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none', 'aria-label': tr('Folder path') },
    });
    this.prompt = h('textarea', {
      class: 'ui-rename__input ui-spawn__prompt',
      attrs: { id: 'ui-spawn-prompt', rows: 5, maxlength: SPAWN_PROMPT_MAX, placeholder: tr('What the agent should do (optional)') },
    });
    this.fileInput = h('input', { type: 'file', hidden: true, attrs: { multiple: true, 'aria-hidden': 'true', tabindex: '-1' } });
    this.fileInput.addEventListener('change', () => {
      this.addFiles([...(this.fileInput.files ?? [])]);
      this.fileInput.value = '';
    });
    const attachBtn = h('button', { class: 'ui-btn ui-spawn__attach', type: 'button', attrs: { title: tr('Attach images or files to the request') }, on: { click: () => this.fileInput.click() } });
    const clip = h('span', { attrs: { 'aria-hidden': 'true' } });
    clip.innerHTML = ICONS.attach;
    attachBtn.append(clip, h('span', { text: tr('Attach') }));
    this.dictate = new DictationButton(
      (t) => {
        const { value, caret } = insertDictation(this.prompt.value, this.prompt.selectionStart ?? this.prompt.value.length, this.prompt.selectionEnd ?? this.prompt.value.length, t.text);
        this.prompt.value = value.slice(0, SPAWN_PROMPT_MAX);
        this.prompt.setSelectionRange(caret, caret);
      },
      (text, error) => this.say(text, error),
    );
    setHidden(this.dictate.el, true);
    this.fileList = h('ul', { class: 'ui-spawn__files', attrs: { 'aria-label': tr('Attachments') } });
    this.submitBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-spawn__go', type: 'button', on: { click: () => void this.submit() } }, tr('Start'));
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    for (const field of [this.folder, this.prompt] as HTMLElement[]) {
      field.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void this.submit();
        }
      });
      field.addEventListener('keyup', (e) => e.stopPropagation());
    }
    this.folder.addEventListener('input', () => {
      this.selected = this.folder.value.trim();
      this.renderFolders();
    });
    const close = iconButton(ICONS.close, tr('Close'), () => this.hide(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-popover ui-spawn', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('New agent'), id: 'ui-spawn', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('New agent') }), close),
      h(
        'div',
        { class: 'ui-set-group ui-spawn__body' },
        h('p', { class: 'ui-spawn__label', attrs: { id: 'ui-spawn-folders-label' }, text: tr('Project') }),
        this.folderList,
        this.otherBtn,
        this.folder,
        h('label', { class: 'ui-spawn__label', attrs: { for: 'ui-spawn-prompt' }, text: tr('Request') }),
        this.prompt,
        h('div', { class: 'ui-spawn__tools' }, this.dictate.el, attachBtn, this.fileInput),
        this.fileList,
        h('p', { class: 'ui-rename__hint', text: tr("Instantly starts a Claude Code session in the background on the computer, in the chosen folder; permissions come here. A folder Claude Code doesn't know yet opens in the Claude app and waits for Enter there. Attachments go to ~/.habblaud/attachments and the request includes their paths.") }),
        this.submitBtn,
        this.status,
      ),
    );
    this.el.addEventListener('toggle', () => {
      this.anchor?.setAttribute('aria-expanded', String(this.isOpen));
      if (!this.isOpen) this.dictate.cancel();
    });
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  toggle(anchor: HTMLElement): void {
    this.anchor = anchor;
    if (this.isOpen) return this.hide();
    // First with what the office already knows; the server's list (history) arrives right after.
    if (!this.folders.length) this.setFolders(spawnFolders(this.ctx.store.snapshot).map((path) => ({ path, name: path.split(/[\\/]/).pop() || path, lastAt: 0 })));
    void this.loadFolders();
    void this.checkDictation();
    if (!this.busy) setText(this.status, '');
    const r = anchor.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
    // On the phone, focusing the field would open the keyboard over the project list.
    if (!matchMedia('(pointer: coarse)').matches) this.prompt.focus();
  }

  hide(): void {
    this.dictate.cancel();
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.anchor?.setAttribute('aria-expanded', 'false');
  }

  private async loadFolders(): Promise<void> {
    try {
      const r = await api<{ folders: FolderOption[] }>('/api/spawn/folders');
      if (Array.isArray(r.folders) && r.folders.length) this.setFolders(r.folders);
    } catch {
      // the room list stays
    }
  }

  private async checkDictation(): Promise<void> {
    setHidden(this.dictate.el, !(await dictationAvailable()));
  }

  private setFolders(list: FolderOption[]): void {
    this.folders = list;
    if (!this.selected) {
      const pref = readPref();
      this.selected = list.some((f) => f.path === pref) ? pref : (list[0]?.path ?? '');
    }
    this.renderFolders();
  }

  private renderFolders(): void {
    const now = Date.now();
    const known = this.folders.some((f) => f.path === this.selected);
    this.folderList.replaceChildren(
      ...this.folders.map((f) => {
        const on = f.path === this.selected && !this.typing;
        const when = ago(f.lastAt, now);
        return h(
          'button',
          {
            class: `ui-spawn__folder${on ? ' is-on' : ''}`,
            type: 'button',
            role: 'radio',
            attrs: { 'aria-checked': String(on), title: f.path },
            on: { click: () => this.pick(f.path) },
          },
          h('span', { class: 'ui-spawn__folder-name', text: f.name }),
          h('span', { class: 'ui-spawn__folder-path', text: shortPath(f.path) }),
          when ? h('span', { class: 'ui-spawn__folder-when', text: when }) : null,
        );
      }),
    );
    if (!this.folders.length) this.showOther(true);
    else if (!known && this.selected && !this.typing) this.showOther(true, this.selected);
  }

  private pick(path: string): void {
    this.selected = path;
    this.typing = false;
    setHidden(this.folder, true);
    this.otherBtn.classList.remove('is-on');
    this.renderFolders();
  }

  private showOther(on: boolean, value?: string): void {
    this.typing = on;
    setHidden(this.folder, !on);
    this.otherBtn.classList.toggle('is-on', on);
    if (on) {
      if (value !== undefined) this.folder.value = value;
      this.selected = this.folder.value.trim();
      this.folderList.querySelectorAll('.ui-spawn__folder').forEach((b) => {
        b.classList.remove('is-on');
        b.setAttribute('aria-checked', 'false');
      });
      if (value === undefined) this.folder.focus();
    }
  }

  private addFiles(list: File[]): void {
    for (const file of list) {
      if (this.files.length >= MAX_FILES) {
        this.say(tr('At most {0} attachments per request.', [MAX_FILES]), true);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        this.say(tr('{0} is over {1} MB.', [file.name, MAX_FILE_BYTES / 1024 / 1024]), true);
        continue;
      }
      if (!file.size) continue;
      const url = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      const item: PendingFile = { file, url, el: h('li', { class: 'ui-spawn__file' }) };
      const thumb = url ? h('img', { class: 'ui-spawn__thumb', attrs: { src: url, alt: '' } }) : h('span', { class: 'ui-spawn__thumb ui-spawn__thumb--doc', attrs: { 'aria-hidden': 'true' }, text: (file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || tr('FILE') });
      const remove = iconButton(ICONS.close, tr('Remove {0}', [file.name]), () => this.removeFile(item), 'ui-icon-btn--sm ui-spawn__file-x');
      item.el.append(thumb, h('span', { class: 'ui-spawn__file-name', text: file.name, attrs: { title: file.name } }), h('span', { class: 'ui-spawn__file-size', text: formatBytes(file.size) }), remove);
      this.files.push(item);
      this.fileList.append(item.el);
    }
  }

  private removeFile(item: PendingFile): void {
    if (item.url) URL.revokeObjectURL(item.url);
    item.el.remove();
    this.files = this.files.filter((f) => f !== item);
  }

  private clearFiles(): void {
    for (const f of [...this.files]) this.removeFile(f);
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (this.dictate.busy) return this.say(tr('Wait for the dictation to finish.'), true);
    const folder = (this.typing ? this.folder.value : this.selected).trim();
    if (!folder) return this.say(tr('Choose the project.'), true);
    this.busy = true;
    this.submitBtn.disabled = true;
    try {
      const ids: string[] = [];
      for (const [i, f] of this.files.entries()) {
        this.say(this.files.length > 1 ? tr('Sending attachments ({0} of {1})…', [i + 1, this.files.length]) : tr('Sending the attachment…'));
        const r = await api<{ id: string }>('/api/spawn/attachments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.file.name, type: f.file.type, data: await fileToBase64(f.file) }),
        });
        ids.push(r.id);
      }
      this.say(tr('Starting on the computer…'));
      let info = await api<SpawnInfo>('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, prompt: this.prompt.value, ...(ids.length ? { attachments: ids } : {}) }),
      });
      const end = Date.now() + WAIT_MS;
      while ((info.status === 'queued' || info.status === 'sent') && Date.now() < end) {
        await new Promise((ok) => setTimeout(ok, POLL_MS));
        info = await api<SpawnInfo>(`/api/spawn/${encodeURIComponent(info.id)}`);
      }
      if (info.status === 'opened') {
        const running = info.how === 'cli';
        this.say(
          running
            ? tr('Running: the session has started on the computer and will show up in the office in a moment.')
            : info.note
              ? tr("Opened in the Claude app: press Enter there to start. It didn't run on its own: {0}.", [info.note])
              : tr('Opened in the Claude app: press Enter there to start.'),
          !running && !!info.note,
        );
        this.prompt.value = '';
        this.clearFiles();
        writePref(folder);
        this.ctx.announce(running ? tr('New agent running.') : tr('New agent opened in the Claude app.'));
      } else this.say(info.error ? tr("Didn't open: {0}", [info.error]) : tr("The computer didn't confirm it opened."), true);
    } catch (err) {
      this.say(tr("Didn't open: {0}", [(err as Error).message]), true);
    } finally {
      this.busy = false;
      this.submitBtn.disabled = false;
    }
  }
}
