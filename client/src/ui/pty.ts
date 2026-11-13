// Interactive terminal: floating window with Claude Code really running (pty on the server, xterm.js here).
// Unlike the live terminal (ui/terminal.ts, which shows the conversation), here you can type, answer and end.
// Session open in another terminal (e.g. Windows Terminal) opens first in the live terminal, with "Take over here";
// this window only shows the "in another terminal" notice when the live terminal is off. The tabs switch
// between the agents of the same project; the two windows take turns in the same place.
// The keys don't leak to the office shortcuts (T, P, M, Esc...): Esc, for example, interrupts Claude.
// Closing the window doesn't end the session; "End" does.
import type { AgentInfo, PtyInfo } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { maximizeButton, Movable } from './movable';
import { closePty, createPty, stopAgent, takeoverAgent } from './ptyapi';
import type { PtyPane } from './ptypane';
import { TermActions } from './termactions';
import { TermTabs } from './termtabs';
import { createAccountChip, updateAccountChip } from './widgets';
import { tr } from '../../../shared/i18n';

/** What the drawer and the shortcuts use from the interactive terminal. */
export interface PtyControl {
  /** Feature on (outside Docker, with node-pty and local access). */
  readonly enabled: boolean;
  /** Why it is off. */
  readonly reason: string;
  /** Interactive terminal of this agent running. */
  ptyOf(agentId: string): PtyInfo | undefined;
  /** Agent open in the window (with a pty or open in another terminal). */
  readonly agentId: string | null;
  readonly isOpen: boolean;
  /** Opens the window on the agent: its pty or, if the session runs in another terminal, the offer to take over. */
  openAgent(agentId: string): void;
  close(): void;
  takeover(agentId: string): Promise<void>;
  newSession(cwd: string, account?: string): Promise<void>;
  stop(agentId: string): Promise<void>;
}

export class PtyPanel implements UiComponent, PtyControl {
  readonly el: HTMLElement;
  private pane: PtyPane | null = null;
  private loading: Promise<PtyPane> | null = null;
  private info: PtyInfo | null = null;
  /** Agent open in another terminal (no pty here), shown with "Take over here". */
  private external: string | null = null;
  private screen: HTMLElement;
  private away: HTMLElement;
  private awayTitle: HTMLElement;
  private nameEl: HTMLElement;
  private accEl: HTMLElement;
  private roomEl: HTMLElement;
  private stateEl: HTMLElement;
  private actions: TermActions;
  private tabs: TermTabs;
  private movable: Movable;
  /** Notified when the window shows (the live terminal closes: there is only one window). */
  onShow: (() => void) | null = null;
  /** Agent to select when it appears in the snapshot (session just opened or taken over). */
  private pendingSelect: string | null = null;

  constructor(private ctx: UiContext) {
    const icon = h('span', { class: 'ui-term__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.terminal;
    this.accEl = createAccountChip('sm');
    this.nameEl = h('strong', { class: 'ui-term__name' });
    this.roomEl = h('span', { class: 'ui-term__room' });
    this.stateEl = h('span', { class: 'ui-pty__state', role: 'status' });
    this.actions = new TermActions(ctx, this, false, async () => {
      if (this.info) await closePty(this.info.id);
    });
    this.tabs = new TermTabs(ctx);
    const close = iconButton(ICONS.close, tr('Close the window (the session keeps running)'), () => this.close(), 'ui-icon-btn--sm ui-term__close');
    const bar = h(
      'div',
      { class: 'ui-term__bar' },
      icon,
      h('span', { class: 'ui-term__kind', text: tr('terminal') }),
      h('div', { class: 'ui-term__who' }, this.accEl, this.nameEl, this.roomEl),
      this.stateEl,
      h('span', { class: 'ui-pty__live', text: tr('interactive') }),
      this.actions.el,
      maximizeButton(() => this.movable, () => requestAnimationFrame(() => this.pane?.refit(true))),
      close,
    );
    this.screen = h('div', { class: 'ui-pty__body' });
    this.awayTitle = h('p', { class: 'ui-pty__away-title' });
    this.away = h(
      'div',
      { class: 'ui-pty__away', hidden: true },
      h('strong', { text: tr('This session is open in another terminal') }),
      this.awayTitle,
      h('p', { class: 'ui-muted', text: tr('Use "Take over here" (at the top) to end it there and continue the same conversation in this window, with typing enabled.') }),
    );
    this.el = h('section', { class: 'ui-term ui-pty', role: 'dialog', hidden: true, attrs: { 'aria-label': tr('Terminal') } }, bar, this.tabs.el, this.screen, this.away);
    // Keys typed in the terminal belong to Claude Code, not to the office shortcuts.
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.movable = new Movable(this.el, bar, { key: 'habblaud.move.term', enabled: () => !ctx.isNarrow(), onMove: () => this.pane?.refit(true) });
    this.el.addEventListener('keyup', (e) => e.stopPropagation());
  }

  get enabled(): boolean {
    return !!this.ctx.store.snapshot?.meta.pty?.enabled && !this.ctx.store.replaying;
  }

  get reason(): string {
    if (this.ctx.store.replaying) return tr('No terminal in the timelapse');
    return this.ctx.store.snapshot?.meta.pty?.reason ?? tr('Interactive terminal off');
  }

  get isOpen(): boolean {
    return this.info !== null || this.external !== null;
  }

  get agentId(): string | null {
    return this.info?.agentId ?? this.external;
  }

  ptyOf(agentId: string): PtyInfo | undefined {
    return this.ctx.store.snapshot?.ptys?.find((p) => p.agentId === agentId && p.exitedAt === undefined);
  }

  openAgent(agentId: string): void {
    const p = this.ptyOf(agentId);
    if (p) return this.show(p);
    this.pane?.detach();
    this.info = null;
    this.external = agentId;
    this.reveal();
    this.render();
    this.ctx.invalidate();
  }

  close(): void {
    if (!this.isOpen) return;
    this.pane?.detach();
    this.info = null;
    this.external = null;
    this.el.hidden = true;
    this.ctx.invalidate();
  }

  async takeover(agentId: string): Promise<void> {
    const p = await takeoverAgent(agentId);
    if (p) this.show(p, true);
  }

  async newSession(cwd: string, account?: string): Promise<void> {
    const p = await createPty(cwd, account);
    if (p) this.show(p, true);
  }

  async stop(agentId: string): Promise<void> {
    await stopAgent(agentId);
    this.ctx.announce(tr('Session ended.'));
  }

  render(): void {
    if (this.external) return this.renderExternal(this.external);
    const info = this.info;
    if (!info) return;
    // The snapshot's list carries the newest state (ended, exit code).
    const fresh = this.ctx.store.snapshot?.ptys?.find((p) => p.id === info.id);
    if (fresh) this.info = fresh;
    const cur = this.info ?? info;
    const agent: AgentInfo | undefined = this.ctx.agent(cur.agentId);
    if (agent && this.pendingSelect === cur.agentId) {
      this.pendingSelect = null;
      this.ctx.select({ type: 'agent', id: agent.id });
    }
    setText(this.nameEl, agent?.name ?? 'Claude Code');
    updateAccountChip(this.accEl, this.ctx.account(cur.account), cur.account);
    setText(this.roomEl, agent?.title ?? cur.cwd);
    const ended = cur.exitedAt !== undefined;
    setText(this.stateEl, ended ? tr('ended') : agent ? '' : cur.resumed ? tr('resuming…') : tr('starting…'));
    this.actions.withTakeover = false;
    this.actions.render(ended ? null : (agent ?? null));
    this.tabs.render(agent ? agent.id : null);
    this.setMode(false);
  }

  /** Session open in another terminal: who it is, what it is about and the "Take over here". */
  private renderExternal(id: string): void {
    // Taken over (from here or from another browser tab): it becomes the real terminal.
    const own = this.ptyOf(id);
    if (own) return this.show(own);
    const agent = this.ctx.agent(id);
    setText(this.nameEl, agent?.name ?? tr('Agent'));
    if (agent) updateAccountChip(this.accEl, this.ctx.account(agent.account), agent.account);
    const room = agent ? this.ctx.store.room(agent.roomId) : undefined;
    setText(this.roomEl, room?.name ?? '');
    setText(this.stateEl, agent ? tr('in another terminal') : tr('left the office'));
    setText(this.awayTitle, agent?.title ?? '');
    setHidden(this.awayTitle, !agent?.title);
    this.actions.withTakeover = true;
    this.actions.render(agent ?? null);
    this.tabs.render(agent ? id : null);
    this.setMode(true);
  }

  private setMode(away: boolean): void {
    setHidden(this.away, !away);
    setHidden(this.screen, away);
    this.el.classList.toggle('is-away', away);
  }

  private reveal(): void {
    if (this.el.hidden) this.movable.restore();
    this.el.hidden = false;
    this.onShow?.();
  }

  private show(p: PtyInfo, fresh = false): void {
    this.info = p;
    this.external = null;
    if (fresh) this.pendingSelect = p.agentId;
    this.reveal();
    this.render();
    void this.ensurePane().then((pane) => {
      if (this.info?.id !== p.id) return;
      pane.attach(p.id);
      requestAnimationFrame(() => {
        pane.refit(true);
        pane.focus();
      });
    });
    this.ctx.invalidate();
  }

  private ensurePane(): Promise<PtyPane> {
    if (this.pane) return Promise.resolve(this.pane);
    this.loading ??= import('./ptypane').then(({ PtyPane }) => {
      this.pane = new PtyPane(() => this.ctx.invalidate());
      this.screen.append(this.pane.el);
      return this.pane;
    });
    return this.loading;
  }
}
