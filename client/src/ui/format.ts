// Formatting in the active language (English by default) (times, numbers, usage). Pure functions: no DOM, tested in ui/format.test.ts.
import { intlLocale, tr } from '../../../shared/i18n';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const LOCALE = intlLocale();

const numberFmt1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const integerFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const usdFmt = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
// 24 h clock in all languages (in English the AM/PM does not fit in the feed column).
const clockFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockSecFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const weekdayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Relative time in the past: "now", "5 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function relativeTime(at: number, now: number): string {
  const diff = now - at;
  if (!Number.isFinite(diff) || diff < 5 * SECOND) return tr('now');
  if (diff < MINUTE) return tr('{0} s ago', [Math.floor(diff / SECOND)]);
  if (diff < HOUR) return tr('{0} min ago', [Math.floor(diff / MINUTE)]);
  if (diff < DAY) return tr('{0} h ago', [Math.floor(diff / HOUR)]);
  return tr('{0} d ago', [Math.floor(diff / DAY)]);
}

/** Readable duration: "12 s", "3 min", "2 h 10 min", "3 d 4 h". */
export function formatDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < MINUTE) return `${Math.floor(v / SECOND)} s`;
  if (v < HOUR) return `${Math.floor(v / MINUTE)} min`;
  if (v < DAY) {
    const h = Math.floor(v / HOUR);
    const m = Math.floor((v % HOUR) / MINUTE);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/**
 * Stopwatch for something that is still running: "0:07", "12:31", "1:02:10"; from 1 day on, "1 d 2 h".
 * Changes every second (good for "time running"); negative values (clocks out of sync) become "0:00".
 */
export function formatElapsed(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (v >= DAY) return formatDuration(v);
  const total = Math.floor(v / SECOND);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Countdown: "in 2 h 10 min", "in 5 min", "in less than 1 min", "now". */
export function formatCountdown(target: number, now: number): string {
  const diff = target - now;
  if (diff <= 0) return tr('now');
  if (diff < MINUTE) return tr('in less than 1 min');
  return `in ${formatDuration(diff)}`;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** How many calendar days (local time) separate `t` from `now` (0 = same day). */
export function calendarDayDiff(t: number, now: number): number {
  return Math.round((startOfDay(t) - startOfDay(now)) / DAY);
}

/**
 * When a usage window resets: "at 14:30" (today), "tomorrow at 01:30" or "Thu, 20:00".
 * An instant already in the past returns "" (it never shows a reset in the past as if it were the next one).
 */
export function formatResetAt(resetsAt: number, now: number): string {
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return '';
  const time = clockFmt.format(resetsAt);
  const days = calendarDayDiff(resetsAt, now);
  if (days <= 0) return tr('at {0}', [time]);
  if (days === 1) return tr('tomorrow at {0}', [time]);
  return `${weekdayFmt.format(resetsAt)}, ${time}`;
}

/** Compact duration for tiny spaces: "45s", "29min", "1h29", "2h", "3d4h". */
export function compactDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < MINUTE) return `${Math.floor(v / SECOND)}s`;
  if (v < HOUR) return `${Math.floor(v / MINUTE)}min`;
  if (v < DAY) {
    const h = Math.floor(v / HOUR);
    const m = Math.floor((v % HOUR) / MINUTE);
    return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  }
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  return h ? `${d}d${h}h` : `${d}d`;
}

export const FIVE_HOURS_MS = 5 * HOUR;
export const WEEK_MS = 7 * DAY;

/** Presentation of a usage window (5 h or week), already taking the age of the numbers into account. */
export interface UsageWindowView {
  /** Percentage 0–100; null when the window renewed after the reading (the current usage is unknown). */
  pct: number | null;
  /** The window has already reset since the numbers were read. */
  renewed: boolean;
  /** Next reset: "in 1 h 29 min" (less than 24 h), "tomorrow, 13:49" or "Thu, 13:49"; "" if unknown. */
  reset: string;
  /** Compact countdown to the reset ("1h29"), for small screens; "" if unknown. */
  resetShort: string;
  /** Full sentence for tooltips and screen readers. */
  summary: string;
}

/**
 * `windowMs` is the window's duration (5 h or 7 d): with no reset time, numbers read longer ago than that
 * no longer count (the window has certainly renewed).
 */
export function usageWindowView(win: { utilization: number; resetsAt?: number } | undefined, fetchedAt: number, now: number, windowMs: number): UsageWindowView | null {
  if (!win) return null;
  const resetsAt = win.resetsAt !== undefined && Number.isFinite(win.resetsAt) ? win.resetsAt : undefined;
  const renewed = resetsAt !== undefined ? resetsAt <= now : now - fetchedAt >= windowMs;
  if (renewed) {
    return {
      pct: null,
      renewed: true,
      reset: tr('renewed'),
      resetShort: tr('renewed'),
      summary: tr('renewed since the last reading (current usage unknown)'),
    };
  }
  const pct = clampPercent(win.utilization);
  if (resetsAt === undefined) return { pct, renewed: false, reset: '', resetShort: '', summary: tr('{0}% used', [pct]) };
  const diff = resetsAt - now;
  let reset: string;
  if (diff < DAY) reset = formatCountdown(resetsAt, now);
  else {
    const time = clockFmt.format(resetsAt);
    reset = calendarDayDiff(resetsAt, now) === 1 ? tr('tomorrow, {0}', [time]) : `${weekdayFmt.format(resetsAt)}, ${time}`;
  }
  const at = formatResetAt(resetsAt, now);
  return {
    pct,
    renewed: false,
    reset,
    resetShort: compactDuration(diff),
    summary: tr('{0}% used · resets {1} ({2})', [pct, at, formatCountdown(resetsAt, now)]),
  };
}

/** "14:30:05" */
export function formatClock(at: number, withSeconds = true): string {
  return (withSeconds ? clockSecFmt : clockFmt).format(at);
}

/** "Oct 06, 14:30" */
export function formatDateTime(at: number): string {
  return dateTimeFmt.format(at);
}

/** Compact tokens: "850", "12,3 k", "1,2 M". */
export function formatTokens(n: number): string {
  const v = Math.max(0, n);
  if (v < 1_000) return integerFmt.format(v);
  if (v < 1_000_000) return `${numberFmt1.format(v / 1_000)} k`;
  return `${numberFmt1.format(v / 1_000_000)} M`;
}

/** Integer with thousands separator: "12.345". */
export function formatInt(n: number): string {
  return integerFmt.format(n);
}

/** Cost in dollars: "US$ 1,23". */
export function formatUSD(n: number): string {
  return usdFmt.format(n).replace(/ /g, ' ');
}

/** Usage percentage limited to 0–100 and rounded. */
export function clampPercent(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.round(Math.min(100, Math.max(0, v)));
}

export type UsageLevel = 'ok' | 'warn' | 'crit';

/** Usage color range: green < 50%, amber 50–80%, red >= 80%. */
export function usageLevel(utilization: number): UsageLevel {
  if (utilization >= 80) return 'crit';
  if (utilization >= 50) return 'warn';
  return 'ok';
}

/** "1 agent", "3 agents" */
export function plural(n: number, singular: string, pluralForm: string): string {
  return `${formatInt(n)} ${n === 1 ? singular : pluralForm}`;
}

/** Removes accents and normalizes for searches ("João" -> "joao"). */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Short model name: "claude-opus-5-5" -> "Opus 5.5". Keeps the original if it does not recognize it. */
export function prettyModel(model: string | undefined): string {
  if (!model) return '—';
  // Codex: "gpt-5.3-codex" -> "GPT-5.3 Codex", "gpt-5.1-codex-mini" -> "GPT-5.1 Codex Mini", "gpt-5" -> "GPT-5".
  const gpt = /^gpt-(\d+(?:\.\d+)?[a-z]?)((?:-[a-z][a-z0-9]*)*)$/i.exec(model);
  if (gpt) {
    const words = gpt[2]
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    return [`GPT-${gpt[1]}`, ...words].join(' ');
  }
  // Formats: "claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-opus-4-20250514", "claude-3-5-sonnet-20241022".
  const m = /claude-(?:(\d{1,2}(?:-\d{1,2})?)-)?([a-z]+)(?:-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?)?/i.exec(model);
  if (!m) return model;
  const family = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
  const version = m[1] ? m[1].replace('-', '.') : m[3] ? (m[4] ? `${m[3]}.${m[4]}` : m[3]) : '';
  return version ? `${family} ${version}` : family;
}

const PERMISSION_LABELS: Record<string, string> = {
  default: tr('Default (asks)'),
  acceptEdits: tr('Accepts edits'),
  plan: tr('Plan mode'),
  bypassPermissions: tr('No confirmations'),
  dontAsk: tr("Doesn't ask"),
  auto: tr('Automatic'),
};

export function permissionLabel(mode: string | undefined): string {
  if (!mode) return '—';
  return PERMISSION_LABELS[mode] ?? mode;
}

/** Shortens paths in the home folder: "/Users/ana/projetos/x" -> "~/projetos/x". */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}
