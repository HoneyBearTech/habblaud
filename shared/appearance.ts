// Parts of the appearance that can be chosen in the character editor: the lists of styles, the validation of what
// arrives through the API and a stable signature. The palettes and the combination rules live in the art
// (client/src/art/character/appearance.ts, editorOptions); only the format lives here. Pure: no Node or DOM.

export const HAIR_STYLES = [
  'short', 'buzz', 'spiky', 'side_part', 'curly', 'afro', 'bob', 'long', 'ponytail', 'bun', 'pigtails', 'mohawk', 'bald', 'wavy',
] as const;
export const TOP_STYLES = ['tshirt', 'hoodie', 'shirt_tie', 'sweater', 'jacket', 'blouse', 'polo'] as const;
export const ACCESSORIES = ['none', 'glasses', 'sunglasses', 'headphones', 'cap', 'beanie', 'earrings', 'bow'] as const;
export const FACIAL_HAIR = ['none', 'stubble', 'beard', 'mustache', 'goatee'] as const;
export const BOTTOM_STYLES = ['pants', 'shorts', 'skirt'] as const;

/** Parts chosen in the editor, applied on top of the appearance drawn from the `seed`. Colors in `#rrggbb`. */
export interface AppearanceParts {
  skin?: string;
  hair?: string;
  hairStyle?: (typeof HAIR_STYLES)[number];
  eyes?: string;
  top?: string;
  topAccent?: string;
  topStyle?: (typeof TOP_STYLES)[number];
  bottom?: string;
  bottomStyle?: (typeof BOTTOM_STYLES)[number];
  shoes?: string;
  accessory?: (typeof ACCESSORIES)[number];
  accessoryColor?: string;
  facialHair?: (typeof FACIAL_HAIR)[number];
}

/**
 * Fixed order of the parts: the same in parseAppearanceParts, partsKey and in the editor (changedParts). The
 * timelapse compares by JSON, so the order has to be stable.
 */
export const PART_KEYS = [
  'skin', 'hair', 'hairStyle', 'eyes', 'top', 'topAccent', 'topStyle', 'bottom', 'bottomStyle', 'shoes', 'accessory',
  'accessoryColor', 'facialHair',
] as const satisfies readonly (keyof AppearanceParts)[];
export type PartKey = (typeof PART_KEYS)[number];

const STYLE_VALUES: Partial<Record<PartKey, readonly string[]>> = {
  hairStyle: HAIR_STYLES,
  topStyle: TOP_STYLES,
  bottomStyle: BOTTOM_STYLES,
  accessory: ACCESSORIES,
  facialHair: FACIAL_HAIR,
};
const COLOR = /^#[0-9a-f]{6}$/i;
// Control (C0/C1), line and paragraph separators (U+2028/2029) and text direction marks (U+200E/200F,
// U+202A–202E, U+2066–2069): a name can be disguised with them.
const CONTROL = /[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export const NAME_MAX = 24;

/** Valid parts in PART_KEYS order (colors in lowercase), or null if anything is out of format. */
export function parseAppearanceParts(raw: unknown): AppearanceParts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  for (const k of Object.keys(src)) if (!(PART_KEYS as readonly string[]).includes(k)) return null;
  const out: Record<string, string> = {};
  for (const k of PART_KEYS) {
    const v = src[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') return null;
    const allowed = STYLE_VALUES[k];
    if (allowed ? !allowed.includes(v) : !COLOR.test(v)) return null;
    out[k] = allowed ? v : v.toLowerCase();
  }
  return out as AppearanceParts;
}

/** Character name: NFC, no extra spaces, from 1 to NAME_MAX characters and no control characters. */
export function parseCharacterName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name || CONTROL.test(name) || [...name].length > NAME_MAX) return null;
  return name;
}

/** Appearance seed: unsigned 32-bit integer. */
export function parseSeed(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 0xffffffff ? raw : null;
}

/** Key for comparing names: "ana" and "Ana" (or "Júlia" in NFD and in NFC) are the same name. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('pt-BR');
}

/** Stable signature of `parts` (avatar cache and change detection). */
export function partsKey(parts: AppearanceParts | undefined): string {
  return parts ? PART_KEYS.map((k) => parts[k] ?? '').join(',') : '';
}
