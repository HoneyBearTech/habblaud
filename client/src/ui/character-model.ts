// Character editor, pure part (no DOM): when the drawer offers editing, how the pieces are grouped, the labels
// and what goes to the server in `parts`. The interface is in character-editor.ts.
import { PART_KEYS, type AppearanceParts, type PartKey } from '../../../shared/appearance';
import { isDemoId } from '../../../shared/timeline';
import type { AgentInfo } from '../../../shared/types';
import type { Appearance } from '../art/api';
import { tr } from '../../../shared/i18n';

export interface EditGate {
  /** The agent is still in the office. */
  live: boolean;
  /** meta.terminal: Habblaud is reachable only from the computer itself (local bind). */
  terminal: boolean;
  /** The page was opened through localhost/127.x (the server refuses the rest). */
  local: boolean;
  replaying: boolean;
  mock: boolean;
}

/**
 * Does the "Edit character" pencil show? Only for the real main agent, live, that is not leaving (offline: the
 * server would answer 404) and with local access (the terminal lock).
 */
export function canEditCharacter(a: Pick<AgentInfo, 'id' | 'kind' | 'status'>, g: EditGate): boolean {
  return a.kind === 'main' && a.status !== 'offline' && g.live && g.terminal && g.local && !g.replaying && !g.mock && !isDemoId(a.id);
}

/** Pieces that differ from the appearance drawn by the seed (what goes in `parts`), in the order of PART_KEYS. */
export function changedParts(base: Appearance, edited: Appearance): AppearanceParts {
  const out: Record<string, string> = {};
  for (const k of PART_KEYS) {
    const v = edited[k];
    if (v !== undefined && v !== base[k]) out[k] = v;
  }
  return out as AppearanceParts;
}

export interface EditorRow {
  key: PartKey;
  label: string;
  kind: 'style' | 'color';
}

export const EDITOR_GROUPS: readonly { title: string; rows: readonly EditorRow[] }[] = [
  { title: tr('Skin'), rows: [{ key: 'skin', label: tr('Tone'), kind: 'color' }] },
  {
    title: tr('Hair'),
    rows: [
      { key: 'hairStyle', label: tr('Style'), kind: 'style' },
      { key: 'hair', label: tr('Color'), kind: 'color' },
    ],
  },
  { title: tr('Beard'), rows: [{ key: 'facialHair', label: tr('Style'), kind: 'style' }] },
  { title: tr('Eyes'), rows: [{ key: 'eyes', label: tr('Color'), kind: 'color' }] },
  {
    title: tr('Top'),
    rows: [
      { key: 'topStyle', label: tr('Style'), kind: 'style' },
      { key: 'top', label: tr('Color'), kind: 'color' },
      { key: 'topAccent', label: tr('Detail'), kind: 'color' },
    ],
  },
  {
    title: tr('Bottom'),
    rows: [
      { key: 'bottomStyle', label: tr('Style'), kind: 'style' },
      { key: 'bottom', label: tr('Color'), kind: 'color' },
    ],
  },
  { title: tr('Shoes'), rows: [{ key: 'shoes', label: tr('Color'), kind: 'color' }] },
  {
    title: tr('Accessory'),
    rows: [
      { key: 'accessory', label: tr('Type'), kind: 'style' },
      { key: 'accessoryColor', label: tr('Color'), kind: 'color' },
    ],
  },
];

const STYLE_LABELS: Partial<Record<PartKey, Readonly<Record<string, string>>>> = {
  hairStyle: {
    short: tr('Short'), buzz: tr('Buzz cut'), spiky: tr('Spiky'), side_part: tr('Side part'), curly: tr('Curly'), afro: tr('Afro'),
    bob: tr('Bob'), long: tr('Long'), ponytail: tr('Ponytail'), bun: tr('Bun'), pigtails: 'Maria-chiquinha', mohawk: tr('Mohawk'),
    bald: tr('Bald'), wavy: tr('Wavy'),
  },
  topStyle: {
    tshirt: tr('T-shirt'), hoodie: tr('Hoodie'), shirt_tie: tr('Shirt and tie'), sweater: tr('Sweater'), jacket: tr('Jacket'),
    blouse: tr('Blouse'), polo: 'Polo',
  },
  bottomStyle: { pants: tr('Pants'), shorts: tr('Shorts'), skirt: tr('Skirt') },
  accessory: {
    none: tr('None'), glasses: tr('Glasses'), sunglasses: tr('Sunglasses'), headphones: tr('Headphones'), cap: tr('Cap'), beanie: tr('Beanie'),
    earrings: tr('Earrings'), bow: tr('Bow'),
  },
  facialHair: { none: tr('No beard'), stubble: tr('Stubble'), beard: tr('Beard'), mustache: tr('Mustache'), goatee: tr('Goatee') },
};

/** Label of a style (hair, clothes, accessory...). */
export function styleLabel(key: PartKey, value: string): string {
  return STYLE_LABELS[key]?.[value] ?? value;
}

/** Does the row show with this appearance? (with no accessory, there is no accessory color to choose) */
export function rowVisible(r: EditorRow, a: Pick<Appearance, 'accessory'>): boolean {
  return !(r.key === 'accessoryColor' && a.accessory === 'none');
}
