// Message box: sends a text to the main agent through Habblaud (POST /api/messages) and the plugin
// habblaud-mensagens delivers it to the session as if you had typed it (in Codex, `codex queue` puts it in the
// session's queue, which uses it when it goes idle). It sits in the agent drawer and in the footer of the
// terminal (only the live session). Enter sends, Shift+Enter breaks the line; the status line follows the delivery
// (GET /api/messages/:id) until it resolves. The keys typed here don't trigger the global shortcuts. The draft of
// each agent is kept (only in memory) when switching agents. The microphone (ui/dictation.ts, local Whisper on the
// Mac) puts the dictated text at the cursor; it shows when dictation works from here. The pure logic is in
// ui/composer-model.ts.
import { MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxMessage, Provider } from '../../../shared/types';
import {
  canSend,
  composerMode,
  composerTip,
  enterSends,
  isSettled,
  LOST_ERROR,
  messageText,
  OFFLINE_ERROR,
  POLL_LIMIT_MS,
  pollDelay,
  sendStatusText,
  timeoutError,
  type ComposerMode,
  type SendState,
} from './composer-model';
import type { UiContext } from './context';
import { DictationButton, dictationAvailable, insertDictation } from './dictation';
import { h, setAttr, setHidden, setText, setTitle } from './dom';
import { access } from '../net/access';
import { tr } from '../../../shared/i18n';

export type ComposerVariant = 'drawer' | 'terminal';

export interface ComposerOptions {
  /** Esc inside the box: where the focus goes (default: just leaves the box). */
  onEscape?: () => void;
}

export class MessageComposer {
  readonly el: HTMLElement;
  /** Agent of the box (or the conversation key, in the history terminal). */
  private agentId = '';
  private mode: ComposerMode = { kind: 'off', text: '' };
  /** Draft per agent: it is what rules the content of the box. */
  private drafts = new Map<string, string>();
  /** Last send of each agent (the status line). */
  private states = new Map<string, SendState>();
  /** Tool of each agent that received a message (the delivery and deadline text changes in Codex). */
  private providers = new Map<string, Provider>();
  /** Tool of the box's agent. */
  private provider: Provider = 'claude';
  /** What the box shows now ("<agent>|<ready>"): when it changes, the content comes from the draft. */
  private shown = '';

  private row: HTMLElement;
  private box: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private tip: HTMLElement | null;
  private status: HTMLElement;
  private dictate: DictationButton;
  /** Dictation line (recording, transcribing, language, error). */
  private dictStatus: HTMLElement;
  private dictTimer: ReturnType<typeof setTimeout> | null = null;
  /** Draft that receives the dictation in progress (the agent may change while the Mac transcribes). */
  private dictKey = '';
  private canDictate = false;

  constructor(
    private ctx: UiContext,
    private variant: ComposerVariant,
    private opts: ComposerOptions = {},
  ) {
    const term = variant === 'terminal';
    this.box = h('textarea', {
      class: `ui-msg__input${term ? ' ui-term__input' : ''}`,
      attrs: { rows: 1, maxlength: MESSAGE_MAX, autocomplete: 'off', enterkeyhint: 'send' },
    });
    this.box.addEventListener('input', () => {
      this.drafts.set(this.agentId, this.box.value);
      this.resize();
      this.syncButton();
    });
    this.box.addEventListener('focus', () => this.resize());
    this.box.addEventListener('keydown', (e) => this.onKey(e));
    this.sendBtn = h(
      'button',
      {
        class: term ? 'ui-msg__send' : 'ui-btn ui-msg__send',
        type: 'button',
        title: tr('Send (Enter)'),
        attrs: { 'aria-label': tr('Send the message') },
        on: { click: () => void this.send() },
      },
      term ? '↵' : tr('Send'),
    );
    this.dictStatus = h('p', { class: 'ui-msg__status ui-msg__dictation', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.dictate = new DictationButton(
      (t) => this.insertDictated(t.text),
      (text, error) => this.sayDictation(text, error),
      { compact: true, onStart: () => (this.dictKey = this.agentId) },
    );
    this.dictate.el.classList.add('ui-msg__mic');
    setHidden(this.dictate.el, true);
    this.row = h('div', { class: `ui-msg__row${term ? ' ui-term__prompt ui-term__prompt--mic' : ''}` });
    if (term) this.row.append(h('span', { class: 'ui-term__caret', text: '>', attrs: { 'aria-hidden': 'true' } }));
    this.row.append(this.box, this.dictate.el, this.sendBtn);
    // A click on the "prompt line" (outside the button) puts the cursor in the box, as in a terminal.
    this.row.addEventListener('mousedown', (e) => {
      if (e.target === this.row && !this.box.disabled) {
        e.preventDefault();
        this.box.focus();
      }
    });
    this.hint = h('p', { class: 'ui-msg__hint', hidden: true });
    this.status = h('p', { class: 'ui-msg__status', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.tip = term ? null : h('p', { class: 'ui-msg__tip', text: composerTip() });
    this.el = h('div', { class: `ui-msg ui-msg--${variant}` }, this.hint, this.row, this.dictStatus, this.status, this.tip);
  }

  /**
   * Updates the box for `agent` (undefined = none: history session or agent that left); `key` identifies the
   * draft. Returns the mode: the drawer hides the section when it is 'off'.
   */
  render(agent: AgentInfo | undefined, key = agent?.id ?? ''): ComposerMode['kind'] {
    const store = this.ctx.store;
    const mode = composerMode(agent, {
      enabled: store.mock || !!store.snapshot?.meta.messages,
      local: store.mock || access().messages,
      replaying: store.replaying,
    });
    this.mode = mode;
    const ready = mode.kind === 'ready';
    const term = this.variant === 'terminal';
    this.provider = agent?.provider === 'codex' ? 'codex' : 'claude';

    // Agent switch (or the box started or stopped applying): the content comes from the saved draft.
    const shown = `${key}|${ready}`;
    if (shown !== this.shown) {
      // Recording for another agent: stops without transcribing (the speech was for that one).
      this.dictate.cancel();
      this.shown = shown;
      this.agentId = key;
      this.box.value = ready ? (this.drafts.get(key) ?? '') : '';
      this.box.style.height = '';
      if (ready) requestAnimationFrame(() => this.resize());
    }
    this.box.disabled = !ready;
    const name = agent?.name ?? tr('the agent');
    const placeholder = ready ? (term ? tr('Message to {0} (Enter sends, Shift+Enter adds a new line)', [name]) : tr('Message to {0}…', [name])) : mode.text;
    setAttr(this.box, 'placeholder', placeholder);
    setAttr(this.box, 'aria-label', ready ? tr('Message to {0}', [name]) : mode.text);
    setTitle(this.box, ready ? '' : mode.text);
    this.row.classList.toggle('is-disabled', !ready);
    setHidden(this.sendBtn, !ready);
    // Cached check (30 s): the Mac may install Whisper or stop the helper with the page open.
    void dictationAvailable().then((ok) => {
      if (ok === this.canDictate) return;
      this.canDictate = ok;
      this.ctx.invalidate();
    });
    // Transcribing: the button stays until the text arrives (it goes to the draft of whoever dictated).
    setHidden(this.dictate.el, !this.canDictate || (!ready && !this.dictate.busy));
    // In the drawer, the plugin hint takes the place of the box; in the terminal it is already in the place of the text.
    setHidden(this.row, !term && !ready);
    if (this.tip) {
      setHidden(this.tip, !ready);
      setText(this.tip, composerTip(this.provider));
    }
    setHidden(this.hint, term || mode.kind !== 'hint');
    setText(this.hint, mode.kind === 'hint' ? mode.text : '');
    this.syncButton();

    const state = this.states.get(key);
    const text = sendStatusText(state, Date.now(), this.providers.get(key) ?? this.provider);
    setText(this.status, text);
    setHidden(this.status, !text);
    this.status.classList.toggle('is-error', state?.phase === 'failed' || state?.phase === 'rejected');
    this.status.classList.toggle('is-ok', state?.phase === 'delivered');
    return mode.kind;
  }

  // ---------------------------------------------------------------- internals

  private onKey(e: KeyboardEvent): void {
    // The global shortcuts (F, T, P, /, arrows...) don't apply inside the box. With Ctrl/⌘ the key goes on through
    // (Ctrl/⌘+F searches the terminal conversation; the global shortcuts ignore these combinations).
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    if (e.key === 'Escape') {
      // Esc only leaves the box (the next one closes the terminal or the drawer).
      e.preventDefault();
      e.stopPropagation();
      if (this.opts.onEscape) this.opts.onEscape();
      else this.box.blur();
      return;
    }
    if (enterSends(e)) {
      e.preventDefault();
      void this.send();
    }
  }

  /**
* Dictated text: at the cursor, if the box is still that of whoever dictated; otherwise, at the end of that
* agent's draft.
*/
  private insertDictated(text: string): void {
    const key = this.dictKey;
    if (key === this.agentId && !this.box.disabled) {
      const box = this.box;
      const { value, caret } = insertDictation(box.value, box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, text);
      box.value = value.slice(0, MESSAGE_MAX);
      this.drafts.set(key, box.value);
      this.resize();
      this.syncButton();
      box.focus({ preventScroll: true });
      box.setSelectionRange(caret, caret);
    } else {
      const cur = this.drafts.get(key) ?? '';
      this.drafts.set(key, insertDictation(cur, cur.length, cur.length, text).value.slice(0, MESSAGE_MAX));
    }
  }

  private sayDictation(text: string, error = false): void {
    if (this.dictTimer) clearTimeout(this.dictTimer);
    setText(this.dictStatus, text);
    setHidden(this.dictStatus, !text);
    this.dictStatus.classList.toggle('is-error', error);
    // Success notices go away by themselves; "Recording…" and "Transcribing…" stay until the next change.
    if (!error && !/…$/.test(text)) this.dictTimer = setTimeout(() => setHidden(this.dictStatus, true), 6_000);
  }

  private syncButton(): void {
    this.sendBtn.disabled = this.mode.kind !== 'ready' || !canSend(this.box.value) || this.states.get(this.agentId)?.phase === 'sending';
  }

  /** Grows with the text up to the CSS limit (~6 lines; then it scrolls). Hidden, it measures when it shows. */
  private resize(): void {
    const box = this.box;
    if (!box.isConnected || box.offsetParent === null) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }

  private setState(agentId: string, state: SendState): void {
    this.states.set(agentId, state);
    if (agentId === this.agentId) this.syncButton();
    this.ctx.invalidate();
  }

  private async send(): Promise<void> {
    const agentId = this.agentId;
    const raw = this.box.value;
    if (this.mode.kind !== 'ready' || !canSend(raw) || this.states.get(agentId)?.phase === 'sending') return;
    this.providers.set(agentId, this.provider);
    this.setState(agentId, { phase: 'sending', at: Date.now() });
    let r: { message: OutboxMessage } | { error: string };
    try {
      r = await this.ctx.store.sendMessage(agentId, messageText(raw));
    } catch {
      r = { error: OFFLINE_ERROR };
    }
    if ('error' in r) {
      // Rejected: the text stays in the box to try again.
      this.setState(agentId, { phase: 'rejected', error: r.error, at: Date.now() });
      return;
    }
    // In the queue: the box empties (unless you kept writing while the send was going).
    if ((this.drafts.get(agentId) ?? '') === raw) {
      this.drafts.delete(agentId);
      if (this.agentId === agentId && this.box.value === raw) {
        this.box.value = '';
        this.resize();
      }
    }
    const m = r.message;
    this.setState(agentId, { phase: m.status, id: m.id, error: m.error, at: Date.now() });
    if (!isSettled(m.status)) this.poll(agentId, m.id, Date.now());
  }

  /** Checks the status until it resolves (or the deadline runs out). Stops when another send takes the status line. */
  private poll(agentId: string, id: string, since: number): void {
    const step = async () => {
      if (this.states.get(agentId)?.id !== id) return;
      let m: OutboxMessage | null | undefined;
      try {
        m = await this.ctx.store.messageStatus(id);
      } catch {
        // No connection now: tries again on the next pass.
      }
      const cur = this.states.get(agentId);
      if (cur?.id !== id) return;
      const now = Date.now();
      if (m === null) return this.setState(agentId, { phase: 'failed', id, error: LOST_ERROR, at: now });
      if (m && (m.status !== cur.phase || m.error !== cur.error)) this.setState(agentId, { phase: m.status, id, error: m.error, at: now });
      if (m && isSettled(m.status)) return;
      const elapsed = now - since;
      if (elapsed >= POLL_LIMIT_MS) return this.setState(agentId, { phase: 'failed', id, error: timeoutError(this.providers.get(agentId)), at: now });
      setTimeout(() => void step(), pollDelay(elapsed));
    };
    setTimeout(() => void step(), pollDelay(0));
  }
}
