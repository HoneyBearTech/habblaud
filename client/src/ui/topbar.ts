// Top bar: brand, connection, counters, usage per account and control buttons.
import { access } from '../net/access';
import { SpawnPanel } from './spawn';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText, setTitle, setVariant } from './dom';
import { formatDuration, formatInt } from './format';
import { FALLBACK_MARK, ICONS } from './icons';
import { computeCounters, shellLine, shellWaitIn, shellWaitingAgents, waitingAgents, type Counters } from './model';
import { TIMELAPSE_ICONS } from './timelapse';
import { focusPermission, nextPermissionAgent, permissionAgents } from './permission';
import { UsageCards } from './usage';
import { VersionChip } from './version';
import { wordmark } from './widgets';
import { tr } from '../../../shared/i18n';

interface CounterRefs {
  el: HTMLElement;
  value: HTMLElement;
  label: HTMLElement;
}

/** Fixed counters (the shells one is separate: it only shows when there are shells running). */
const COUNTERS: { key: Exclude<keyof Counters, 'shells'>; singular: string; plural: string; hint: string }[] = [
  { key: 'rooms', singular: tr('room'), plural: tr('rooms'), hint: tr('Open rooms (one per project)') },
  { key: 'agents', singular: tr('agent'), plural: tr('agents'), hint: tr('Agents in the office (main and subagents)') },
  { key: 'working', singular: tr('working'), plural: tr('working'), hint: tr('Agents processing a request right now') },
  { key: 'subagents', singular: tr('subagent'), plural: tr('subagents'), hint: tr('Active subagents') },
  { key: 'waiting', singular: tr('needs you'), plural: tr('need you'), hint: tr('Agents waiting for your reply in the terminal') },
];
const WAITING_HINT = COUNTERS.find((c) => c.key === 'waiting')!.hint;

export class TopBar implements UiComponent {
  readonly el: HTMLElement;
  private pill: HTMLElement;
  private pillText: HTMLElement;
  private demoBadge: HTMLElement;
  /** Bottom line of the brand (connection, version, badges): the Habblaud World chip goes in here (ui/index.ts). */
  private status: HTMLElement;
  private counters = new Map<keyof Counters, CounterRefs>();
  private shellsBtn: HTMLButtonElement;
  /** Next agent of the shells button (clicks in a row go through all of them, from the one waiting the longest). */
  private shellCursor = 0;
  private usage: UsageCards;
  private version: VersionChip;
  private hadOpen = false;
  private sidebarBtn: HTMLButtonElement;
  private feedBtn: HTMLButtonElement;
  private timelapseBtn: HTMLButtonElement;
  readonly settingsBtn: HTMLButtonElement;
  /** Opens the Habblaud World window (next to Settings); the window decides when the button shows. */
  readonly worldBtn: HTMLButtonElement;
  private readonly spawnBtn: HTMLButtonElement;
  private readonly spawnPanel: SpawnPanel;
  /** Group of the panel buttons (feed, Habblaud World, settings, help); the history goes in here (ui/index.ts). */
  readonly panelGroup: HTMLElement;

  constructor(private ctx: UiContext) {
    // Brand: uses the project's logo if there is one; otherwise, the pixel building.
    const mark = h('span', { class: 'ui-brand__mark' });
    const logo = h('img', { attrs: { src: '/assets/brand/logo-mark.png', srcset: '/assets/brand/logo-mark@4x.png 4x', alt: '', width: 32, height: 32, draggable: 'false' } });
    logo.addEventListener('error', () => {
      mark.innerHTML = FALLBACK_MARK;
    });
    mark.append(logo);

    this.pillText = h('span', { class: 'ui-pill__text' });
    this.pill = h('span', { class: 'ui-pill', role: 'status', attrs: { 'aria-live': 'polite' } }, h('span', { class: 'ui-pill__dot' }), this.pillText);
    this.demoBadge = h('span', { class: 'ui-demo-badge', text: tr('Demo'), title: tr('Demo agents on (turn them off in Settings)'), hidden: true });

    const counterWrap = h('div', { class: 'ui-counters', role: 'group', attrs: { 'aria-label': tr('Office summary') } });
    for (const c of COUNTERS) {
      const value = h('span', { class: 'ui-counter__value', text: '0' });
      const label = h('span', { class: 'ui-counter__label', text: c.plural });
      let el: HTMLElement;
      if (c.key === 'waiting') {
        // On small screens the label goes away and the raised hand stays.
        const icon = h('span', { class: 'ui-counter__icon', attrs: { 'aria-hidden': 'true' } });
        icon.innerHTML = ICONS.hand;
        el = h('button', { class: 'ui-counter ui-counter--waiting', type: 'button', title: tr('{0}. Click to go to the first one.', [c.hint]), on: { click: () => this.focusFirstWaiting() } }, icon, value, label);
      } else {
        el = h('div', { class: `ui-counter ui-counter--${c.key}`, title: c.hint }, value, label);
      }
      this.counters.set(c.key, { el, value, label });
      counterWrap.append(el);
    }

    // "⏳ N shells": between the subagents and "needs you"; goes away when there are no shells running.
    {
      const icon = h('span', { class: 'ui-counter__icon ui-hourglass', attrs: { 'aria-hidden': 'true' } });
      icon.innerHTML = ICONS.hourglass;
      const value = h('span', { class: 'ui-counter__value', text: '0' });
      const label = h('span', { class: 'ui-counter__label', text: 'shells' });
      this.shellsBtn = h(
        'button',
        { class: 'ui-counter ui-counter--shells', type: 'button', hidden: true, on: { click: () => this.focusNextShell() } },
        icon,
        h('span', { class: 'ui-counter__stack' }, value, label),
      );
      this.counters.set('shells', { el: this.shellsBtn, value, label });
      counterWrap.insertBefore(this.shellsBtn, this.counters.get('waiting')!.el);
    }

    this.usage = new UsageCards(ctx);

    this.sidebarBtn = iconButton(ICONS.sidebar, tr('Sidebar ( [ )'), () => ctx.togglePanel('sidebar'), 'ui-btn-sidebar');
    this.feedBtn = iconButton(ICONS.feed, tr('Activity feed ( ] )'), () => ctx.togglePanel('feed'), 'ui-btn-feed');
    this.timelapseBtn = iconButton(TIMELAPSE_ICONS.timelapse, tr('Timelapse: replay the day (L)'), () => ctx.toggleTimelapse(), 'ui-btn-timelapse');
    // Habblaud World: hidden until its window (ui/world/world-dialog.ts) says there is a world server configured.
    this.worldBtn = iconButton(ICONS.city, tr('Habblaud World'), () => ctx.toggleWorld(), 'ui-btn-world');
    this.worldBtn.setAttribute('aria-haspopup', 'dialog');
    this.worldBtn.hidden = true;
    this.settingsBtn = iconButton(ICONS.settings, tr('Settings'), () => ctx.toggleSettings());
    this.settingsBtn.setAttribute('aria-haspopup', 'dialog');
    this.spawnPanel = new SpawnPanel(ctx);
    ctx.root.append(this.spawnPanel.el);
    this.spawnBtn = iconButton(ICONS.newAgent, tr('New agent: starts a Claude Code session on the computer'), () => this.spawnPanel.toggle(this.spawnBtn), 'ui-btn-spawn');
    this.spawnBtn.setAttribute('aria-haspopup', 'dialog');
    this.spawnBtn.hidden = true;
    this.version = new VersionChip(ctx, this.settingsBtn);
    this.status = h('div', { class: 'ui-topbar__status' }, this.pill, this.version.el, this.demoBadge);
    const viewGroup = h(
      'div',
      { class: 'ui-btn-group', role: 'group', attrs: { 'aria-label': tr('Camera') } },
      iconButton(ICONS.overview, tr('Overview (O)'), () => ctx.camera('overview')),
      iconButton(ICONS.zoomOut, tr('Zoom out (−)'), () => ctx.camera('zoomOut')),
      iconButton(ICONS.zoomIn, tr('Zoom in (+)'), () => ctx.camera('zoomIn')),
    );
    const panelGroup = h(
      'div',
      { class: 'ui-btn-group', role: 'group', attrs: { 'aria-label': tr('Panels') } },
      this.spawnBtn,
      this.timelapseBtn,
      this.feedBtn,
      this.worldBtn,
      this.settingsBtn,
      iconButton(ICONS.help, tr('Help (?)'), () => ctx.openHelp()),
    );
    this.panelGroup = panelGroup;

    this.el = h(
      'header',
      { class: 'ui-topbar', role: 'banner' },
      h(
        'div',
        { class: 'ui-topbar__left' },
        this.sidebarBtn,
        h(
          'div',
          { class: 'ui-brand' },
          mark,
          h('div', { class: 'ui-brand__text' }, wordmark(), this.status),
        ),
      ),
      counterWrap,
      this.usage.el,
      h('div', { class: 'ui-topbar__right' }, viewGroup, panelGroup),
    );
  }

  /** Adds a badge to the brand's status line, after the version (e.g. the Habblaud World chip). */
  addStatus(el: HTMLElement): void {
    this.status.append(el);
  }

  /** World button (scene switch), next to the Timelapse one. */
  addSceneButton(btn: HTMLElement): void {
    this.panelGroup.insertBefore(btn, this.timelapseBtn);
  }

  /** Adds a button with its own window (e.g. My day) to the start of the panel group. */
  addPanelButton(btn: HTMLElement): void {
    this.panelGroup.prepend(btn);
  }

  render(): void {
    const { store } = this.ctx;
    const snap = store.snapshot;

    // Connection.
    const conn = store.connection;
    if (conn === 'open') this.hadOpen = true;
    const label =
      conn === 'open' ? tr('Connected') : conn === 'mock' ? tr('Simulation') : conn === 'closed' ? tr('Disconnected') : this.hadOpen ? tr('Reconnecting…') : tr('Connecting…');
    setText(this.pillText, label);
    setVariant(this.pill, 'is-', conn);
    setTitle(
      this.pill,
      conn === 'mock'
        ? tr('Simulated data in the browser (?mock=1)')
        : conn === 'open'
          ? tr('Receiving server events in real time')
          : tr('No connection to the Habblaud server'),
    );
    setHidden(this.demoBadge, !(conn === 'open' && snap?.meta.demo));

    // Counters.
    const now = this.ctx.now();
    const c = computeCounters(snap, now);
    for (const def of COUNTERS) {
      const refs = this.counters.get(def.key)!;
      const n = c[def.key];
      setText(refs.value, formatInt(n));
      setText(refs.label, n === 1 ? def.singular : def.plural);
      setAttr(refs.el, 'aria-label', `${formatInt(n)} ${n === 1 ? def.singular : def.plural}`);
    }
    const waiting = this.counters.get('waiting')!.el as HTMLButtonElement;
    waiting.classList.toggle('is-active', c.waiting > 0);
    waiting.disabled = c.waiting === 0;
    // Requests that can be answered from here (permission hook: permissions and questions): the tooltip says how many.
    const answerable = permissionAgents(snap?.agents ?? []).length;
    waiting.classList.toggle('has-answer', answerable > 0);
    setTitle(
      waiting,
      answerable
        ? tr('{0}. {1} answered here: click to go to {2} (P).', [WAITING_HINT, answerable === 1 ? tr('1 request (permission or question) can be') : tr('{0} requests (permissions or questions) can be', [answerable]), answerable === 1 ? tr('it') : tr('each one')])
        : tr('{0}. Click to go to the first one.', [WAITING_HINT]),
    );
    this.renderShells(c.shells, now);

    this.usage.render();
    this.version.render();
    setHidden(this.spawnBtn, !access().spawn || store.mock || store.replaying);

    this.sidebarBtn.setAttribute('aria-pressed', String(this.ctx.isPanelOpen('sidebar')));
    this.feedBtn.setAttribute('aria-pressed', String(this.ctx.isPanelOpen('feed')));
    this.timelapseBtn.setAttribute('aria-pressed', String(this.ctx.isTimelapseOpen()));
    setHidden(this.timelapseBtn, store.mock);
  }

  private renderShells(n: number, now: number): void {
    const refs = this.counters.get('shells')!;
    setHidden(this.shellsBtn, n === 0);
    if (n === 0) {
      this.shellCursor = 0;
      return;
    }
    const all = this.ctx.store.snapshot?.agents ?? [];
    const agents = shellWaitingAgents(all, now);
    setText(refs.value, formatInt(n));
    setText(refs.label, n === 1 ? 'shell' : 'shells');
    const who = agents.length === 1 ? agents[0].name : tr('{0} agents', [formatInt(agents.length)]);
    setAttr(refs.el, 'aria-label', tr('{0} {1}; {2} waiting. Go to the next one.', [formatInt(n), n === 1 ? tr('shell running') : tr('shells running'), who]));
    // Tooltip: who is waiting for what, from the one waiting the longest.
    const lines = agents.slice(0, 6).map((a) => {
      const w = shellWaitIn(a, all, now)!;
      return `${a.name}: ${shellLine(w, now).label} (${formatDuration(now - w.since)})`;
    });
    if (agents.length > 6) lines.push(tr('… and {0} more', [agents.length - 6]));
    setTitle(refs.el, tr('Shells running: {0} for them to finish.\n{1}\nClick to go to {2}.', [agents.length === 1 ? tr('the agent is waiting') : tr('the agents are waiting'), lines.join('\n'), agents.length > 1 ? tr('each one') : tr('it')]));
  }

  private focusNextShell(): void {
    const agents = shellWaitingAgents(this.ctx.store.snapshot?.agents ?? [], this.ctx.now());
    if (!agents.length) return;
    // If the current one is already selected, moves on to the next in the queue.
    const sel = this.ctx.selection();
    let i = this.shellCursor % agents.length;
    if (sel?.type === 'agent' && agents[i].id === sel.id) i = (i + 1) % agents.length;
    this.shellCursor = i + 1;
    this.ctx.select({ type: 'agent', id: agents[i].id }, { focus: true });
  }

  private focusFirstWaiting(): void {
    // Those who have a request to answer from the office come first (clicks in a row go through all of them).
    const agents = this.ctx.store.snapshot?.agents ?? [];
    const sel = this.ctx.selection();
    const next = nextPermissionAgent(agents, sel?.type === 'agent' ? sel.id : undefined);
    if (next) return focusPermission(this.ctx, next.id);
    const first = waitingAgents(agents)[0];
    if (first) this.ctx.select({ type: 'agent', id: first.id }, { focus: true });
  }
}
