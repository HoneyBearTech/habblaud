// Introduction phrases of the Habblaud World player: the protocol carries only the id (IntroId); the text is translated
// in the browser of whoever sees it. Pure: no Node or DOM.
import { tr } from '../i18n';
import { INTRO_IDS, type IntroId } from './protocol';

export { INTRO_IDS, type IntroId };

/** One function per id (tr runs on the spot, in the active language). The Record forces having all the ids. */
const LABELS: Readonly<Record<IntroId, () => string>> = {
  night_owl: () => tr('I code late at night'),
  early_bird: () => tr('I get up early to code'),
  coffee: () => tr('Powered by coffee'),
  tea: () => tr('Team tea'),
  tabs: () => tr('Team tabs'),
  spaces: () => tr('Team spaces'),
  dark_mode: () => tr('Dark mode, always'),
  light_mode: () => tr('Light mode, no fear'),
  vim: () => tr('Vim till the end'),
  tests_first: () => tr('I test before I write'),
  ship_fast: () => tr('I ship fast'),
  refactor: () => tr('Refactoring is my hobby'),
  pixel_art: () => tr('Pixel art fan'),
  music: () => tr('I code with music on'),
  silence: () => tr('I code in silence'),
  cats: () => tr('Cat person'),
  dogs: () => tr('Dog person'),
  open_source: () => tr('Open source all the way'),
  learning: () => tr('Always learning'),
  hello: () => tr('Hi, nice to meet you!'),
};

export function isIntroId(v: unknown): v is IntroId {
  return typeof v === 'string' && (INTRO_IDS as readonly string[]).includes(v);
}

/** Text of the phrase in the active language (an id this version does not know, from a newer server: the id itself). */
export function introLabel(id: IntroId): string {
  return LABELS[id]?.() ?? String(id);
}

/** All the phrases, in the order of INTRO_IDS (for the picker). */
export function introOptions(): { id: IntroId; label: string }[] {
  return INTRO_IDS.map((id) => ({ id, label: introLabel(id) }));
}
