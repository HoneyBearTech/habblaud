// USAGE PER ACCOUNT cards in the top bar: 5-hour session and weekly, with the reset and the source of the numbers.
// Presentation rules:
// - an old number never passes for a current one: a window that already renewed after the reading shows "—" and
//   "renewed"; old numbers are grayed out with the age ("6 d ago") in the header or, on the phone, a badge on the chip;
// - the reset comes with the verb implied in the ↻ icon and a countdown when less than a day is left;
// - an account with no numbers says "no usage data" and offers "How to enable" (Habblaud mod, recommended).
// Codex account: the numbers come from its session files, which only renew while some session is running; that is why
// the age ("12 min ago") is always on display. No quota or credits ("no quota") never becomes 0%. There is nothing to
// install for the usage: "How it works" opens the help at the Codex section. No Opus/Sonnet or email (only the plan).
import type { AccountInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, KeyedList, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import { FIVE_HOURS_MS, relativeTime, usageLevel, usageWindowView, WEEK_MS, type UsageWindowView } from './format';
import { ICONS } from './icons';
import { isCodex } from './provider';
import { usageRowFits } from './usage-row';
import { createAccountChip, createProviderTag, updateAccountChip, updateProviderTag } from './widgets';
import { tr } from '../../../shared/i18n';

export const SOURCE_LABEL: Record<NonNullable<AccountInfo['usage']>['source'], string> = {
  cache: tr('Claude Code /usage cache'),
  statusline: tr('live (Claude Code statusline)'),
  codex: tr('Codex files'),
};

/** Source to show: the live file may have been written by the Habblaud mod or by the tap. */
export function sourceLabel(u: NonNullable<AccountInfo['usage']>): string {
  if (u.source === 'statusline' && u.via === 'mod') return tr('live (Habblaud mod)');
  return SOURCE_LABEL[u.source] ?? u.source;
}

/**
 * How to turn on the usage of an account, in order of preference (card tooltip and help).
 * Parts between backticks become code (no line break in the middle of the command).
 */
export const USAGE_SETUP_STEPS: readonly [string, string][] = [
  [
    'npm run mod:install',
    tr('Recommended: installs the Habblaud mod in Claude Code (2.1.287 or newer), which streams 5 h and weekly usage live. Run it in the Habblaud folder, on the computer where Claude Code runs; in sessions already open, `/reload-plugins`.'),
  ],
  [
    'npm run usage:install',
    tr('On Claude Code older than 2.1.287: hooks a tap into the status line, which streams the same numbers live.'),
  ],
  ['/usage', tr('Without installing anything: run `/usage` in Claude Code on this account to refresh the cache (the numbers go stale until the next time).')],
];

/** Text with parts `assim` as code. */
export function richText(text: string): Node[] {
  return text.split('`').map((part, i) => (i % 2 ? h('code', { class: 'ui-usage-setup__inline', text: part }) : document.createTextNode(part)));
}

interface Meter {
  el: HTMLElement;
  bar: HTMLElement;
  pct: HTMLElement;
  reset: HTMLElement;
  resetLong: HTMLElement;
  resetShort: HTMLElement;
}

interface CardRefs {
  chip: HTMLElement;
  flag: HTMLElement;
  name: HTMLElement;
  prov: HTMLElement;
  email: HTMLElement;
  state: HTMLElement;
  stateText: HTMLElement;
  meters: HTMLElement;
  five: Meter;
  week: Meter;
  msg: HTMLElement;
  msgLong: HTMLElement;
  msgShort: HTMLElement;
  how: HTMLButtonElement;
  howLong: HTMLElement;
  howShort: HTMLElement;
  tip: HTMLElement;
  tipTitle: HTMLElement;
  tipRows: HTMLElement;
  tipNote: HTMLElement;
  tipSetup: HTMLElement;
}

let tipSeq = 0;

function createMeter(long: string, short: string, title: string): Meter {
  const bar = h('span', { class: 'ui-meter__bar' }, h('span', { class: 'ui-meter__fill' }));
  const pct = h('span', { class: 'ui-meter__pct' });
  const resetLong = h('span', { class: 'ui-meter__reset-long' });
  const resetShort = h('span', { class: 'ui-meter__reset-short' });
  const reset = h('span', { class: 'ui-meter__reset' }, resetLong, resetShort);
  const label = h(
    'span',
    { class: 'ui-meter__label' },
    h('span', { class: 'ui-meter__label-long', text: long }),
    h('span', { class: 'ui-meter__label-short', text: short, attrs: { 'aria-hidden': 'true' } }),
  );
  const el = h('div', { class: 'ui-meter', role: 'img', attrs: { 'aria-label': title } }, label, bar, pct, reset);
  return { el, bar, pct, reset, resetLong, resetShort };
}

function updateMeter(m: Meter, view: UsageWindowView | null, windowName: string): void {
  if (!view || view.pct === null) {
    setVariant(m.el, 'is-', 'none');
    m.el.classList.remove('is-zero');
    m.el.classList.toggle('is-renewed', !!view?.renewed);
    setStyleVar(m.bar, '--pct', '0');
    setText(m.pct, '—');
    setText(m.resetLong, view?.renewed ? tr('↻ reset') : '');
    setText(m.resetShort, '');
    const text = view ? `${windowName}: ${view.summary}` : tr('{0}: no data', [windowName]);
    setAttr(m.el, 'aria-label', text);
    setTitle(m.el, view?.renewed ? tr('{0}: the window has reset since the last reading; current usage is unknown.', [windowName]) : text);
    return;
  }
  const p = view.pct;
  m.el.classList.remove('is-renewed');
  setVariant(m.el, 'is-', usageLevel(p));
  m.el.classList.toggle('is-zero', p === 0);
  setStyleVar(m.bar, '--pct', String(p));
  setText(m.pct, `${p}%`);
  setText(m.resetLong, view.reset ? `↻ ${view.reset}` : '');
  setText(m.resetShort, view.resetShort ? `↻${view.resetShort}` : '');
  setAttr(m.el, 'aria-label', `${windowName}: ${view.summary}`);
  setTitle(m.el, `${windowName}: ${view.summary}`);
}

function syncRows(dl: HTMLElement, rows: [string, string][]): void {
  while (dl.children.length > rows.length * 2) dl.lastElementChild!.remove();
  rows.forEach(([k, v], i) => {
    let dt = dl.children[i * 2] as HTMLElement | undefined;
    let dd = dl.children[i * 2 + 1] as HTMLElement | undefined;
    if (!dt || !dd) {
      dt = h('dt');
      dd = h('dd');
      dl.append(dt, dd);
    }
    setText(dt, k);
    setText(dd, v);
  });
}

/** Step by step to turn on the usage (card tooltip and help). */
export function createUsageSetup(): HTMLElement {
  return h(
    'ol',
    { class: 'ui-usage-setup' },
    ...USAGE_SETUP_STEPS.map(([cmd, text]) => h('li', {}, h('code', { class: 'ui-usage-setup__cmd', text: cmd }), h('span', {}, ...richText(text)))),
  );
}

/** ok/stale: recent/old numbers; empty: no numbers; noquota: Codex with no quota or credits (never 0%). */
export type CardState = 'ok' | 'stale' | 'empty' | 'noquota';

function hasWindows(a: Pick<AccountInfo, 'usage'>): boolean {
  return !!a.usage && !!(a.usage.fiveHour || a.usage.sevenDay);
}

/** Effective state of the card. */
export function cardState(a: Pick<AccountInfo, 'usage' | 'usageStatus'>): CardState {
  // "No quota" comes first: the reading brings no windows, but it isn't "no data".
  if (a.usage?.noQuota) return 'noquota';
  // A reading with none of the windows (e.g. /usage cache with no numbers) counts as "no data".
  if (!hasWindows(a)) return 'empty';
  return a.usageStatus === 'ok' ? 'ok' : 'stale';
}

/** Is the age of the numbers always on display? (Codex: they only renew while some session is running.) */
export function showsUsageAge(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>): boolean {
  if (!a.usage) return false;
  const state = cardState(a);
  return state === 'stale' || (isCodex(a) && state !== 'empty');
}

/** Line under the name: email; on Codex (no email), the plan; on the others, the folder. */
export function usageSubtitle(a: Pick<AccountInfo, 'email' | 'plan' | 'configDir' | 'provider'>): string {
  if (a.email) return a.email;
  if (isCodex(a)) return a.plan ? tr('{0} plan', [a.plan]) : 'Codex';
  return a.configDir;
}

/** Message in place of the bars (states with no numbers): [long, short]. */
export function usageMessage(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>): [string, string] {
  const state = cardState(a);
  if (state === 'noquota') return [tr('no quota'), tr('no quota')];
  if (isCodex(a)) return [tr('no data yet'), tr('no data')];
  return [tr('no usage data'), tr('no data')];
}

/** Explanation of the card of a Codex account (tooltip); '' on the others. */
export function codexUsageNote(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>, now: number): string {
  if (!isCodex(a)) return '';
  const u = a.usage;
  const state = cardState(a);
  if (state === 'empty') return tr('Nothing to install: the numbers arrive with the next Codex session.');
  const age = u ? relativeTime(u.fetchedAt, now) : '';
  if (state === 'noquota')
    return tr("At the last reading ({0}), the account had no quota or credits left to use (e.g. the workspace credits ran out). It's not 0%: Codex didn't report the windows. The numbers come back with the next session.", [age]);
  return tr('Codex only records usage while a session is running: these numbers are from the last reading ({0}).', [age]);
}

export class UsageCards {
  readonly el: HTMLElement;
  private list: KeyedList<AccountInfo>;
  private refs = new WeakMap<HTMLElement, CardRefs>();

  constructor(private ctx: UiContext) {
    this.el = h('div', { class: 'ui-usage', role: 'group', attrs: { 'aria-label': tr('Usage by account') } });
    this.list = new KeyedList<AccountInfo>(this.el, {
      key: (a) => a.id,
      create: () => this.createCard(),
      update: (el, a) => this.updateCard(el, a),
    });
    // The window width changed: redoes the fit-or-not calculation (see fit()).
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.fit()).observe(ctx.root);
  }

  render(): void {
    const accounts = this.ctx.store.snapshot?.accounts ?? [];
    this.list.sync(accounts);
    this.el.classList.toggle('is-empty', accounts.length === 0);
    setStyleVar(this.el, '--count', String(accounts.length));
    // Measuring forces the page layout, and the render runs every frame in the replay: only when the accounts change (the
    // window width is left to the constructor's ResizeObserver).
    const key = accounts.map((a) => a.id).join('|');
    if (key !== this.fitKey) {
      this.fitKey = key;
      this.fit();
    }
  }

  /** Accounts of the last measurement in fit() (see render). */
  private fitKey = '';

  /**
   * Do the cards not fit on the bar's line (many accounts or a narrow window)? Then they go to a second line
   * (`has-usage-row` on the root, rules in styles.css). It only counts the minimum sizes, which don't depend on the row
   * being on one line or the other, so the result doesn't oscillate. On the phone the bar already has two lines (its own
   * CSS block).
   */
  private fit(): void {
    const bar = this.el.parentElement;
    if (!bar) return;
    if (window.matchMedia('(max-width: 600px)').matches) {
      this.ctx.root.classList.remove('has-usage-row');
      return;
    }
    const barStyle = getComputedStyle(bar);
    const px = (v: string) => Number.parseFloat(v) || 0;
    // Natural width of the other items (scrollWidth): on the single line they shrink, on the bottom line they don't, and
    // the decision can't depend on which of the two states the bar is in.
    const others = [...bar.children]
      .filter((c) => c !== this.el && getComputedStyle(c).display !== 'none')
      .map((c) => Math.max((c as HTMLElement).offsetWidth, c.scrollWidth));
    const fits = usageRowFits({
      barWidth: bar.clientWidth - px(barStyle.paddingLeft) - px(barStyle.paddingRight),
      others,
      gap: px(barStyle.columnGap),
      cardGap: px(getComputedStyle(this.el).columnGap),
      cards: [...this.el.children].map((c) => px(getComputedStyle(c).minWidth)),
    });
    this.ctx.root.classList.toggle('has-usage-row', !fits);
  }

  private createCard(): HTMLElement {
    const tipId = `ui-usage-tip-${++tipSeq}`;
    const chip = createAccountChip('lg');
    const flag = h('span', { class: 'ui-usage-card__flag', hidden: true, attrs: { 'aria-hidden': 'true' } });
    flag.innerHTML = ICONS.clock;
    const name = h('span', { class: 'ui-usage-card__name' });
    const prov = createProviderTag('ui-prov--xs');
    const email = h('span', { class: 'ui-usage-card__email' });
    const stateIcon = h('span', { class: 'ui-usage-card__state-icon', attrs: { 'aria-hidden': 'true' } });
    stateIcon.innerHTML = ICONS.clock;
    const stateText = h('span');
    const state = h('span', { class: 'ui-usage-card__state' }, stateIcon, stateText);
    const five = createMeter('5h', '5h', tr('5-hour session'));
    const week = createMeter(tr('Week'), tr('Wk.'), tr('Weekly limit'));
    const meters = h('div', { class: 'ui-usage-card__meters' }, five.el, week.el);
    const msgLong = h('span', { class: 'ui-usage-card__msg-long', text: tr('no usage data') });
    const msgShort = h('span', { class: 'ui-usage-card__msg-short', text: tr('no data'), attrs: { 'aria-hidden': 'true' } });
    const howLong = h('span', { class: 'ui-usage-card__how-long', text: tr('How to enable') });
    const howShort = h('span', { class: 'ui-usage-card__how-short', text: tr('Enable'), attrs: { 'aria-hidden': 'true' } });
    const howBtn = h(
      'button',
      {
        class: 'ui-usage-card__how',
        type: 'button',
        title: tr("How to show this account's usage (opens help at “Accounts and usage”)"),
        on: { click: () => this.ctx.openHelp(howBtn.dataset.help === 'codex' ? 'codex' : 'usage') },
      },
      howLong,
      howShort,
    );
    const msg = h('div', { class: 'ui-usage-card__msg' }, h('span', { class: 'ui-usage-card__msg-text' }, msgLong, msgShort), howBtn);
    const tipTitle = h('div', { class: 'ui-usage-tip__title' });
    const tipRows = h('dl', { class: 'ui-kv' });
    const tipNote = h('p', { class: 'ui-usage-tip__note' });
    const tipSetup = h('div', { class: 'ui-usage-tip__setup' }, h('p', { class: 'ui-usage-tip__setup-title', text: tr('How to get live usage') }), createUsageSetup());
    const tip = h('div', { class: 'ui-usage-tip', role: 'tooltip', attrs: { id: tipId } }, tipTitle, tipRows, tipNote, tipSetup);
    const card = h(
      'div',
      { class: 'ui-usage-card', tabIndex: 0, attrs: { 'aria-describedby': tipId } },
      chip,
      flag,
      h('div', { class: 'ui-usage-card__body' }, h('div', { class: 'ui-usage-card__head' }, name, prov, email, state), meters, msg),
      tip,
    );
    this.refs.set(card, {
      chip,
      flag,
      name,
      prov,
      email,
      state,
      stateText,
      meters,
      five,
      week,
      msg,
      msgLong,
      msgShort,
      how: howBtn,
      howLong,
      howShort,
      tip,
      tipTitle,
      tipRows,
      tipNote,
      tipSetup,
    });
    return card;
  }

  private updateCard(card: HTMLElement, a: AccountInfo): void {
    const r = this.refs.get(card)!;
    const now = this.ctx.now();
    const codex = isCodex(a);
    updateAccountChip(r.chip, a);
    setStyleVar(card, '--acc', a.color);
    setText(r.name, a.name);
    updateProviderTag(r.prov, codex ? 'codex' : 'claude', a.name);
    setText(r.email, usageSubtitle(a));
    setAttr(card, 'aria-label', tr('{0}{1}: plan usage', [a.name, codex ? ' (Codex)' : '']));

    const usage = a.usage;
    const state = cardState(a);
    setVariant(card, 'is-', state);
    const five = usage ? usageWindowView(usage.fiveHour, usage.fetchedAt, now, FIVE_HOURS_MS) : null;
    const week = usage ? usageWindowView(usage.sevenDay, usage.fetchedAt, now, WEEK_MS) : null;
    const showMeters = hasWindows(a);
    setHidden(r.meters, !showMeters);
    if (usage && showMeters) {
      updateMeter(r.five, five, tr('5-hour session'));
      updateMeter(r.week, week, tr('Week'));
    }
    r.meters.classList.toggle('is-dim', state !== 'ok');

    // Age of the old numbers in the header (on the phone, a badge on the chip plays that role). On Codex the age is
    // always on display (the numbers only renew while some session is running), discreet while they are recent.
    const stale = state === 'stale';
    const showAge = showsUsageAge(a);
    setHidden(r.state, !showAge);
    setHidden(r.flag, !stale);
    r.state.classList.toggle('is-fresh', showAge && a.usageStatus === 'ok');
    if (showAge && usage) {
      const age = relativeTime(usage.fetchedAt, now);
      setText(r.stateText, age);
      setTitle(
        r.state,
        codex
          ? tr('Updated {0}: Codex only records usage while a session is running.', [age])
          : tr('Numbers from {0}: they may not reflect current usage.', [age]),
      );
    }

    // No numbers: "no usage data" + "How to enable" (on Codex, "How it works": there is nothing to install). No quota:
    // the message, with no button.
    const [msgLong, msgShort] = usageMessage(a);
    setText(r.msgLong, msgLong);
    setText(r.msgShort, msgShort);
    setHidden(r.msg, state !== 'empty' && state !== 'noquota');
    setHidden(r.how, state === 'noquota');
    r.msg.classList.toggle('is-noquota', state === 'noquota');
    setTitle(r.msg, state === 'noquota' ? codexUsageNote(a, now) : '');
    setText(r.howLong, codex ? tr('How it works') : tr('How to enable'));
    setText(r.howShort, codex ? tr('Learn more') : tr('Enable'));
    r.how.dataset.help = codex ? 'codex' : 'usage';
    setTitle(r.how, codex ? tr('How Codex usage reaches Habblaud (opens help at “Codex”)') : tr("How to show this account's usage (opens help at “Accounts and usage”)"));
    this.updateTip(r, a, state, five, week, now);
  }

  private updateTip(r: CardRefs, a: AccountInfo, state: CardState, five: UsageWindowView | null, week: UsageWindowView | null, now: number): void {
    const codex = isCodex(a);
    setText(r.tipTitle, `${a.name}${codex && !/codex/i.test(a.name) ? ' · Codex' : ''}${a.plan ? tr(' · {0} plan', [a.plan]) : ''}`);
    const rows: [string, string][] = [];
    if (codex) rows.push([tr('Tool'), 'Codex']);
    if (a.email) rows.push(['E-mail', a.email]);
    if (a.organization) rows.push([tr('Organization'), a.organization]);
    if (a.plan) rows.push([tr('Plan'), a.plan]);
    rows.push([tr('Folder'), a.configDir]);
    rows.push([tr('Open sessions'), String(a.sessions)]);
    const u = a.usage;
    if (u && (u.fiveHour || u.sevenDay)) {
      rows.push([tr('5 h session'), five?.summary ?? '—']);
      rows.push([tr('Week'), week?.summary ?? '—']);
      // Opus and Sonnet are Claude windows: on Codex they don't exist.
      const opus = codex ? null : usageWindowView(u.sevenDayOpus, u.fetchedAt, now, WEEK_MS);
      const sonnet = codex ? null : usageWindowView(u.sevenDaySonnet, u.fetchedAt, now, WEEK_MS);
      if (opus) rows.push([tr('Opus (week)'), opus.summary]);
      if (sonnet) rows.push([tr('Sonnet (week)'), sonnet.summary]);
    }
    if (u && state === 'noquota') rows.push([tr('Quota'), tr('no quota or credits right now')]);
    if (u && (state !== 'empty' || codex)) {
      rows.push([tr('Source'), sourceLabel(u)]);
      rows.push([tr('Updated'), relativeTime(u.fetchedAt, now)]);
    }
    syncRows(r.tipRows, rows);

    // Codex: its own explanation, without the Claude Code step by step (there is nothing to install for the usage).
    if (codex) {
      const note = codexUsageNote(a, now);
      setText(r.tipNote, note);
      setHidden(r.tipNote, !note);
      setHidden(r.tipSetup, true);
      return;
    }

    let note = '';
    if (state === 'empty')
      note = u ? tr('The last reading ({0}, {1}) had no 5 h or weekly numbers.', [sourceLabel(u), relativeTime(u.fetchedAt, now)]) : tr('No usage numbers for this account yet.');
    else if (state === 'stale') note = tr('Old numbers: they reflect the last reading, not current usage.');
    else if (u?.source === 'cache') note = tr('/usage cache: updates when someone runs /usage on this account.');
    else if (five?.renewed || week?.renewed) note = tr('One of the windows has reset since the last reading.');
    setText(r.tipNote, note);
    setHidden(r.tipNote, !note);
    // The step by step shows whenever the numbers aren't live.
    const live = u?.source === 'statusline' && state === 'ok';
    setHidden(r.tipSetup, live);
  }
}
