// Editor do personagem, parte pura (sem DOM): quando a gaveta oferece a edição, como as peças se agrupam, os rótulos
// em português e o que vai para o servidor em `parts`. A interface fica em character-editor.ts.
import { PART_KEYS, type AppearanceParts, type PartKey } from '../../../shared/appearance';
import { isDemoId } from '../../../shared/timeline';
import type { AgentInfo } from '../../../shared/types';
import type { Appearance } from '../art/api';
import { tr } from '../../../shared/i18n';

export interface EditGate {
  /** O agente ainda está no escritório. */
  live: boolean;
  /** meta.terminal: o Habblaud só é acessível pelo próprio computador (bind local). */
  terminal: boolean;
  /** A página foi aberta por localhost/127.x (o servidor recusa o resto). */
  local: boolean;
  replaying: boolean;
  mock: boolean;
}

/**
 * O lápis "Editar personagem" aparece? Só para o principal real, ao vivo, que não está saindo (offline: o servidor
 * responderia 404) e com acesso local (a trava do terminal).
 */
export function canEditCharacter(a: Pick<AgentInfo, 'id' | 'kind' | 'status'>, g: EditGate): boolean {
  return a.kind === 'main' && a.status !== 'offline' && g.live && g.terminal && g.local && !g.replaying && !g.mock && !isDemoId(a.id);
}

/** Peças que diferem da aparência sorteada pela seed (o que vai em `parts`), na ordem de PART_KEYS. */
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

/** Rótulo em português de um estilo (cabelo, roupa, acessório...). */
export function styleLabel(key: PartKey, value: string): string {
  return STYLE_LABELS[key]?.[value] ?? value;
}

/** A linha aparece com esta aparência? (sem acessório, não há cor de acessório para escolher) */
export function rowVisible(r: EditorRow, a: Pick<Appearance, 'accessory'>): boolean {
  return !(r.key === 'accessoryColor' && a.accessory === 'none');
}
