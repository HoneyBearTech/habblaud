import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, loadPrefs, migrateLegacyKeys, PREFS_KEY, sanitizePrefs, savePrefs, worldOptionsFrom } from './prefs';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

/** Com o que a migração precisa a mais: listar (key/length) e apagar. */
function listableStorage(initial: Record<string, string> = {}) {
  const st = memoryStorage(initial);
  return {
    ...st,
    removeItem: (k: string) => void st.data.delete(k),
    key: (i: number) => [...st.data.keys()][i] ?? null,
    get length() {
      return st.data.size;
    },
  };
}

describe('preferences', () => {
  it('uses the default without storage or with invalid JSON', () => {
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(memoryStorage({ [PREFS_KEY]: '{oops' }))).toEqual(DEFAULT_PREFS);
  });
  it('validates field by field', () => {
    const p = sanitizePrefs({ showNames: false, bubbles: 'many', liveliness: 'lively', sound: 'yes', hiddenAccounts: ['.claude', 3] });
    expect(p.showNames).toBe(false);
    expect(p.bubbles).toBe(DEFAULT_PREFS.bubbles);
    expect(p.liveliness).toBe('lively');
    expect(p.sound).toBe(false);
    expect(p.hiddenAccounts).toEqual(['.claude']);
  });
  it('saves and loads back', () => {
    const st = memoryStorage();
    savePrefs(st, { ...DEFAULT_PREFS, bubbles: 'none', feedOpen: false });
    expect(loadPrefs(st)).toEqual({ ...DEFAULT_PREFS, bubbles: 'none', feedOpen: false });
  });
  it('does not break when the storage throws an exception', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(loadPrefs(broken)).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs(broken, DEFAULT_PREFS)).not.toThrow();
  });
  it('extracts only the world options', () => {
    expect(worldOptionsFrom({ ...DEFAULT_PREFS, daylight: 'day' })).toEqual({ showNames: true, bubbles: 'important', liveliness: 'normal', dayNight: false, daylight: 'day', theme: 'auto' });
    expect(worldOptionsFrom({ ...DEFAULT_PREFS, daylight: 'night' })).toMatchObject({ dayNight: true, daylight: 'night' });
  });
  it('day/night cycle: validates the mode and migrates the old switch', () => {
    expect(DEFAULT_PREFS.daylight).toBe('auto');
    expect(sanitizePrefs({ daylight: 'night' }).daylight).toBe('night');
    expect(sanitizePrefs({ daylight: 'noon' }).daylight).toBe('auto');
    expect(sanitizePrefs({ dayNight: false }).daylight).toBe('day');
    expect(sanitizePrefs({ dayNight: true }).daylight).toBe('auto');
    expect(sanitizePrefs({ dayNight: false, daylight: 'night' }).daylight).toBe('night');
  });
  it('themes: preserves old preferences and recovers invalid values', () => {
    expect(sanitizePrefs({ daylight: 'night' })).toMatchObject({ theme: 'auto', daylight: 'night' });
    expect(sanitizePrefs({ theme: 'invalid' }).theme).toBe('auto');
    for (const theme of ['christmas', 'halloween', 'none', 'auto'] as const) {
      const st = memoryStorage();
      savePrefs(st, { ...DEFAULT_PREFS, theme });
      expect(loadPrefs(st).theme).toBe(theme);
      expect(worldOptionsFrom(loadPrefs(st)).theme).toBe(theme);
    }
  });
  it('sounds: off by default; volume and categories validated', () => {
    expect(DEFAULT_PREFS.sound).toBe(false);
    const p = sanitizePrefs({ sound: true, sounds: { volume: 3, keys: false, elevator: 'yes' } });
    expect(p.sound).toBe(true);
    expect(p.sounds).toEqual({ volume: 1, alerts: true, keys: false, elevator: true, social: true });
    expect(sanitizePrefs({ sounds: { volume: -1 } }).sounds.volume).toBe(0);
    expect(sanitizePrefs({ sounds: 'loud' }).sounds).toEqual(DEFAULT_PREFS.sounds);
  });
});

describe('migration from the old name (CodeTown)', () => {
  it('moves the keys to the new prefix and deletes the old ones', () => {
    const prefs = JSON.stringify({ ...DEFAULT_PREFS, bubbles: 'none' });
    const wallets = JSON.stringify({ v: 1, wallets: { a1: { name: 'Ana', coins: 250 } } });
    const st = listableStorage({ 'codetown:prefs': prefs, 'codetown:update-seen': '0.3.2', 'codetown.wallets.v1': wallets });
    expect(migrateLegacyKeys(st)).toBe(3);
    expect(Object.fromEntries(st.data)).toEqual({ 'habblaud:prefs': prefs, 'habblaud:update-seen': '0.3.2', 'habblaud.wallets.v1': wallets });
    expect(loadPrefs(st).bubbles).toBe('none');
  });
  it('does not overwrite the new key that already exists, but deletes the old one', () => {
    const st = listableStorage({ 'codetown:prefs': '{"bubbles":"none"}', [PREFS_KEY]: '{"bubbles":"all"}' });
    expect(migrateLegacyKeys(st)).toBe(0);
    expect(Object.fromEntries(st.data)).toEqual({ [PREFS_KEY]: '{"bubbles":"all"}' });
  });
  it('ignores keys without the old prefix', () => {
    const st = listableStorage({ 'other:thing': '1', codetown: '2', 'codetownx:prefs': '3', 'my.codetown:prefs': '4' });
    expect(migrateLegacyKeys(st)).toBe(0);
    expect(st.data.size).toBe(4);
    expect(migrateLegacyKeys(listableStorage())).toBe(0);
  });
  it('does not break without storage or when it throws an exception', () => {
    expect(migrateLegacyKeys(null)).toBe(0);
    const blocked = {
      ...listableStorage(),
      get length(): number {
        throw new Error('blocked');
      },
    };
    expect(migrateLegacyKeys(blocked)).toBe(0);
    // cota cheia: a chave antiga fica para a próxima vez
    const full = listableStorage({ 'codetown:prefs': '{}' });
    full.setItem = () => {
      throw new Error('full');
    };
    expect(migrateLegacyKeys(full)).toBe(0);
    expect(Object.fromEntries(full.data)).toEqual({ 'codetown:prefs': '{}' });
  });
});
