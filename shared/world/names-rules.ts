// Rules of the Habblaud World player name (Phase 1 contract, section 1). Habblaud checks before sending, to warn
// right away; the one that decides is the world server, which applies the same rules plus the list of blocked words
// (which stays only there). It only imports ./protocol: it can be copied to the world server as is. Pure: no Node or DOM.
//
// The name, after NFC, trim and collapsing repeated spaces:
// - has 3 to 20 characters (code points);
// - has only letters, combining accents (at most 3 in a row, after a letter), digits 0-9, space, `_`, `-` and `.`,
//   with at least one letter;
// - has no control, formatting, direction marks, special spaces or invisible characters (including those that
//   Unicode classifies as a letter but that draw nothing, like the Hangul filler U+3164);
// - uses a single writing system (Latin, Cyrillic, Greek, Arabic...); Japanese (kanji + hiragana + katakana), Korean
//   (hangul + hanja) and Chinese (han + bopomofo) count as a single one;
// - is not a reserved name (compared by the key, without spaces or `_`, `-`, `.`).
// The uniqueness key (playerNameKey) treats as equal names that differ only in width, case, accents or spaces.
import { PLAYER_NAME_LIMITS, RESERVED_PLAYER_NAMES } from './protocol';

/** Why the name was refused (the server answers only the code; the reason is for the local message). */
export type PlayerNameProblem =
  | 'type' // not text
  | 'length' // outside 3 to 20 characters
  | 'invisible' // control, formatting, direction, special space or invisible
  | 'chars' // character outside the list (or too many stacked accents)
  | 'scripts' // letters from more than one writing system
  | 'no_letter' // no letter
  | 'reserved'; // reserved name

export type PlayerNameResult =
  | { ok: true; name: string; key: string }
  | { ok: false; code: 'name_invalid' | 'name_blocked'; problem: PlayerNameProblem };

/** Combining accents in a row accepted after a letter (the rest is "zalgo text"). */
const MAX_MARKS = 3;

/**
 * Invisibles and the like: control, formatting, private, unassigned (\p{C}), line and paragraph separators, the
 * default ignorables (ZWJ, variation selectors, Hangul fillers...) and the direction marks.
 */
const INVISIBLE = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/u;
/** A space that is not the ordinary space (NBSP, ideographic space, tab...). */
const ODD_SPACE = /(?! )[\p{Zs}\s]/u;
const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const OTHER_ALLOWED = /^[0-9 _.-]$/;

/** Recognized writing systems, by Unicode's Script_Extensions. */
const SCRIPTS = [
  'Latin', 'Greek', 'Cyrillic', 'Armenian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana', 'Devanagari', 'Bengali', 'Gurmukhi',
  'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar',
  'Georgian', 'Hangul', 'Ethiopic', 'Khmer', 'Mongolian', 'Hiragana', 'Katakana', 'Bopomofo', 'Han',
] as const;
const SCRIPT_RE = SCRIPTS.map((s) => [s, new RegExp(`^\\p{Script_Extensions=${s}}$`, 'u')] as const);
/** Letter of a system outside the list: valid on its own (two unknown systems together are not told apart). */
const OTHER = 'Other';
/** Combinations that count as a single system. */
const WRITING_SYSTEMS: readonly (readonly string[])[] = [
  ...SCRIPTS.map((s) => [s]),
  ['Han', 'Hiragana', 'Katakana'],
  ['Hangul', 'Han'],
  ['Han', 'Bopomofo'],
  [OTHER],
];

function scriptsOf(letter: string): string[] {
  const found = SCRIPT_RE.filter(([, re]) => re.test(letter)).map(([s]) => s);
  return found.length ? found : [OTHER];
}

/** Do the letters fit in a single writing system? (Each letter can belong to more than one, like the Japanese "ー".) */
function oneWritingSystem(letters: readonly string[]): boolean {
  const sets = [...new Set(letters)].map(scriptsOf);
  return WRITING_SYSTEMS.some((system) => sets.every((s) => s.some((x) => system.includes(x))));
}

/** Name with no spaces at the ends and with repeated spaces collapsed (only the ordinary space: the others are refused). */
function tidy(raw: string): string {
  return raw.normalize('NFC').trim().replace(/ {2,}/g, ' ');
}

/**
 * Uniqueness key of the name: NFKC → lowercase → no diacritics → collapsed spaces. "Márcio", "MARCIO",
 * "ｍａｒｃｉｏ" and "marcio " give the same key.
 */
export function playerNameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\p{Mn}\p{Me}]/gu, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Key without the accepted separators (space, `_`, `-`, `.`), to compare with the reserved ones. */
function compactKey(key: string): string {
  return key.replace(/[ _.-]/g, '');
}

const invalid = (problem: PlayerNameProblem): PlayerNameResult => ({ ok: false, code: 'name_invalid', problem });

/** Checks and tidies the player name; returns the name to save and its key, or the server's code and the reason. */
export function parsePlayerName(raw: unknown): PlayerNameResult {
  if (typeof raw !== 'string') return invalid('type');
  // Huge text is not even processed.
  if (raw.length > PLAYER_NAME_LIMITS.max * 8) return invalid('length');
  const name = tidy(raw);
  if (INVISIBLE.test(name) || ODD_SPACE.test(name)) return invalid('invisible');
  const chars = [...name];
  if (chars.length < PLAYER_NAME_LIMITS.min || chars.length > PLAYER_NAME_LIMITS.max) return invalid('length');
  const letters: string[] = [];
  let marks = 0;
  let prevLetter = false;
  for (const ch of chars) {
    if (LETTER.test(ch)) {
      letters.push(ch);
      marks = 0;
      prevLetter = true;
    } else if (MARK.test(ch)) {
      if (!prevLetter || ++marks > MAX_MARKS) return invalid('chars');
    } else if (OTHER_ALLOWED.test(ch)) {
      marks = 0;
      prevLetter = false;
    } else return invalid('chars');
  }
  if (!letters.length) return invalid('no_letter');
  if (!oneWritingSystem(letters)) return invalid('scripts');
  const key = playerNameKey(name);
  if ((RESERVED_PLAYER_NAMES as readonly string[]).includes(compactKey(key))) return { ok: false, code: 'name_blocked', problem: 'reserved' };
  return { ok: true, name, key };
}
