// Frases de apresentação do jogador do Habblaud World: o protocolo leva só o id (IntroId); o texto é traduzido no
// navegador de quem vê. Puro: sem Node nem DOM.
import { tr } from '../i18n';
import { INTRO_IDS, type IntroId } from './protocol';

export { INTRO_IDS, type IntroId };

/** Uma função por id (o tr roda na hora, no idioma ativo). O Record obriga a ter todos os ids. */
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

/** Texto da frase no idioma ativo (um id que esta versão não conhece, vindo de um servidor mais novo: o próprio id). */
export function introLabel(id: IntroId): string {
  return LABELS[id]?.() ?? String(id);
}

/** Todas as frases, na ordem de INTRO_IDS (para o seletor). */
export function introOptions(): { id: IntroId; label: string }[] {
  return INTRO_IDS.map((id) => ({ id, label: introLabel(id) }));
}
