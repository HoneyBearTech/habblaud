// Nomes fictícios dos andares (shared/world/floor-names.ts, copiado igual no servidor do mundo) e os rótulos traduzidos.
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { floorLabel, isFloorNameId } from './floor-labels';
import { FLOOR_NAME_IDS } from './floor-names';

afterEach(() => setLocale('en'));

describe('floor names', () => {
  it('60 ASCII ids, without repeating, and the draw order starts with ipe, jade and aurora', () => {
    expect(FLOOR_NAME_IDS).toHaveLength(60);
    expect(new Set(FLOOR_NAME_IDS).size).toBe(60);
    for (const id of FLOOR_NAME_IDS) expect(id).toMatch(/^[a-z]+$/);
    expect([FLOOR_NAME_IDS[0], FLOOR_NAME_IDS[20], FLOOR_NAME_IDS[40]]).toEqual(['ipe', 'jade', 'aurora']);
  });

  it('each id has its own label in the 4 languages', () => {
    expect(floorLabel('ipe')).toBe('Project Ipê');
    expect(floorLabel('lapislazuli')).toBe('Project Lapis Lazuli');
    const en = FLOOR_NAME_IDS.map(floorLabel);
    expect(new Set(en).size).toBe(60);
    for (const [locale, prefix] of [['pt-BR', 'Projeto '], ['es', 'Proyecto '], ['fr', 'Projet ']] as const) {
      setLocale(locale);
      const labels = FLOOR_NAME_IDS.map(floorLabel);
      expect(new Set(labels).size, locale).toBe(60);
      for (const l of labels) expect(l.startsWith(prefix), `${locale}: ${l}`).toBe(true);
    }
    setLocale('pt-BR');
    expect(floorLabel('ipe')).toBe('Projeto Ipê');
    expect(floorLabel('carvalho')).toBe('Projeto Carvalho');
    setLocale('en');
    expect(floorLabel('carvalho')).toBe('Project Oak');
  });

  it('unknown id (from a newer version of the server) becomes just "Project"', () => {
    expect(isFloorNameId('ipe')).toBe(true);
    expect(isFloorNameId('new')).toBe(false);
    expect(floorLabel('new')).toBe('Project');
  });
});
