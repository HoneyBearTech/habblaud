// Labels of Habblaud World's light social (Phase 5): greetings, front desk stamps, report reasons and city goals.
// The protocol carries only the id; the text (and the icon) comes from here, in the language of whoever sees it, like
// intro.ts and traits.ts. Pure: no Node or DOM.
import { intlLocale, tr } from '../i18n';
import {
  CITY_GOAL_IDS,
  GREETING_IDS,
  REPORT_REASONS,
  STAMP_IDS,
  type CityGoalId,
  type GreetingId,
  type ReportReason,
  type StampId,
  type TokenBand,
} from './protocol';

export { CITY_GOAL_IDS, GREETING_IDS, REPORT_REASONS, STAMP_IDS };
export type { CityGoalId, GreetingId, ReportReason, StampId };

/** An id with the icon (emoji) and the text in the active language. */
export interface SocialLabel {
  icon: string;
  label: () => string;
}

/** The 10 greetings, in the order of the wheel (the Record forces having all the ids). */
export const GREETINGS: Readonly<Record<GreetingId, SocialLabel>> = {
  hello: { icon: '👋', label: () => tr('Hello!') },
  nice_building: { icon: '👍', label: () => tr('Nice building!') },
  coffee: { icon: '☕', label: () => tr('Coffee?') },
  congrats: { icon: '🎉', label: () => tr('Congrats on shipping!') },
  nice_to_meet: { icon: '🤝', label: () => tr('Nice to meet you!') },
  bye: { icon: '✌️', label: () => tr('See you!') },
  thanks: { icon: '🙏', label: () => tr('Thanks!') },
  good_luck: { icon: '🍀', label: () => tr('Good luck!') },
  wave: { icon: '🙋', label: () => tr('Hey there!') },
  clap: { icon: '👏', label: () => tr('Well done!') },
};

/** The 8 front desk stamps. */
export const STAMPS: Readonly<Record<StampId, SocialLabel>> = {
  visited: { icon: '👣', label: () => tr('I was here') },
  nice_building: { icon: '🏢', label: () => tr('Lovely building') },
  keep_going: { icon: '💪', label: () => tr('Keep it up') },
  coffee: { icon: '☕', label: () => tr('Have a coffee') },
  wave: { icon: '👋', label: () => tr('A wave') },
  star: { icon: '⭐', label: () => tr('Top marks') },
  heart: { icon: '💖', label: () => tr('With love') },
  rocket: { icon: '🚀', label: () => tr('Taking off!') },
};

/** The fixed report reasons. */
export const REPORTS: Readonly<Record<ReportReason, SocialLabel>> = {
  offensive_name: { icon: '🤬', label: () => tr('Offensive name') },
  impersonation: { icon: '🎭', label: () => tr('Pretending to be someone else') },
  harassment: { icon: '🚫', label: () => tr('Harassment') },
  greeting_spam: { icon: '📢', label: () => tr('Greeting spam') },
  fake_building: { icon: '🏚️', label: () => tr('Fake building') },
  other: { icon: '❔', label: () => tr('Other reason') },
};

/** Agent hours of each city goal (the server sends the `target` too; this is only the label). */
export const CITY_GOAL_HOURS: Readonly<Record<CityGoalId, number>> = {
  agent_hours_10k: 10_000,
  agent_hours_50k: 50_000,
  agent_hours_100k: 100_000,
};

const ofList = <K extends string>(list: Readonly<Record<K, SocialLabel>>, id: string): SocialLabel | undefined =>
  (Object.prototype.hasOwnProperty.call(list, id) ? list[id as K] : undefined);

/** Text of a greeting (an id this version does not know: the id itself, without breaking). */
export function greetingLabel(id: GreetingId | string): string {
  return ofList(GREETINGS, id)?.label() ?? String(id);
}

export function greetingIcon(id: GreetingId | string): string {
  return ofList(GREETINGS, id)?.icon ?? '💬';
}

export function stampLabel(id: StampId | string): string {
  return ofList(STAMPS, id)?.label() ?? String(id);
}

export function stampIcon(id: StampId | string): string {
  return ofList(STAMPS, id)?.icon ?? '🏷️';
}

export function reportLabel(id: ReportReason | string): string {
  return ofList(REPORTS, id)?.label() ?? String(id);
}

/** Short number in the active language ("10K", "1.2K", "50K"). */
export function compactNumber(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0;
  try {
    return new Intl.NumberFormat(intlLocale(), { notation: 'compact', maximumFractionDigits: v < 10_000 && v >= 1_000 ? 1 : 0 }).format(v);
  } catch {
    return String(Math.round(v));
  }
}

/** "10K hours of agents working" (the week's goal). */
export function cityGoalLabel(id: CityGoalId | string, target?: number): string {
  const hours = target ?? (Object.prototype.hasOwnProperty.call(CITY_GOAL_HOURS, id) ? CITY_GOAL_HOURS[id as CityGoalId] : 0);
  return tr('{0} hours of agents working', [compactNumber(hours)]);
}

/** The token range (TokenBand) as a readable cap: "up to 100 thousand", "up to 1 million"... "over 100 million". */
export function tokenBandText(band: TokenBand | number | undefined): string {
  switch (band) {
    case 1:
      return tr('up to 100 thousand tokens');
    case 2:
      return tr('up to 1 million tokens');
    case 3:
      return tr('up to 10 million tokens');
    case 4:
      return tr('up to 100 million tokens');
    case 5:
      return tr('over 100 million tokens');
    default:
      return tr('almost no tokens');
  }
}
