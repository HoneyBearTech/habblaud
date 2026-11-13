import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocale, intlLocale, LOCALES, normalizeLocale, serverLocale, setLocale, tr } from './i18n';
import { ES } from './locales/es';
import { FR } from './locales/fr';
import { PT_BR } from './locales/pt-BR';

const placeholders = (s: string) => new Set(s.match(/\{\w+\}/g) ?? []);

describe('i18n', () => {
  afterEach(() => setLocale('en'));

  it("the tests run in English, whatever the machine's language", () => {
    expect(getLocale()).toBe('en');
    expect(LOCALES.map((l) => l.id)).toEqual(['en', 'pt-BR', 'es', 'fr']);
  });

  it('recognizes the language formats of the browser and of the system', () => {
    expect(normalizeLocale('fr')).toBe('fr');
    expect(normalizeLocale('fr-CA')).toBe('fr');
    expect(normalizeLocale('fr_FR.UTF-8')).toBe('fr');
    expect(normalizeLocale('pt')).toBe('pt-BR');
    expect(normalizeLocale('pt_PT')).toBe('pt-BR');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('es_AR.UTF-8')).toBe('es');
    expect(normalizeLocale('de-DE')).toBeUndefined();
    expect(normalizeLocale('')).toBeUndefined();
    expect(normalizeLocale(null)).toBeUndefined();
  });

  it('in English returns the text itself, with the placeholders filled in', () => {
    expect(tr('Reading {0}', ['app.ts'])).toBe('Reading app.ts');
    expect(tr('Text nobody translated')).toBe('Text nobody translated');
  });

  it('in French translates and may reorder the placeholders', () => {
    setLocale('fr');
    expect(tr('Reading {0}', ['app.ts'])).toBe('Lit app.ts');
    expect(tr('Text nobody translated')).toBe('Text nobody translated');
    expect(intlLocale()).toBe('fr-FR');
  });

  it('placeholders without an argument stay as they are (the named ones are filled in by the caller)', () => {
    expect(tr('I won {a} to {b}! 🏆')).toBe('I won {a} to {b}! 🏆');
    expect(tr('{0} and {1}', ['one'])).toBe('one and {1}');
  });

  it("server: HABBLAUD_LANG wins for any language; then the system's language, English included; else English", () => {
    expect(serverLocale({ HABBLAUD_LANG: 'en' }, 'pt-BR')).toBe('en');
    expect(serverLocale({ HABBLAUD_LANG: 'es-MX', LANG: 'fr_FR.UTF-8' })).toBe('es');
    expect(serverLocale({ HABBLAUD_LANG: 'pt-BR', LANG: 'en_US.UTF-8' }, 'en-US')).toBe('pt-BR');
    // A Mac with LANG in English and a container without LANG (Intl en-US): the office is in English.
    expect(serverLocale({ LANG: 'en_US.UTF-8' }, 'en-US')).toBe('en');
    expect(serverLocale({}, 'en-US')).toBe('en');
    expect(serverLocale({ LANG: 'en_US.UTF-8' }, 'pt-BR')).toBe('en');
    expect(serverLocale({ LANG: 'pt_BR.UTF-8' }, 'en-US')).toBe('pt-BR');
    expect(serverLocale({}, 'pt-BR')).toBe('pt-BR');
    expect(serverLocale({ LANG: 'fr_FR.UTF-8' })).toBe('fr');
    expect(serverLocale({ LC_ALL: 'es_ES.UTF-8', LANG: 'en_US.UTF-8' })).toBe('es');
    expect(serverLocale({}, 'es-AR')).toBe('es');
    // Nothing set, or a language that is not supported: English.
    expect(serverLocale({})).toBe('en');
    expect(serverLocale({ LANG: 'C.UTF-8' }, 'de-DE')).toBe('en');
  });

  it("Portuguese and Spanish translate and use the language's date format", () => {
    expect(intlLocale()).toBe('en-US');
    setLocale('pt-BR');
    expect(tr('Reading {0}', ['app.ts'])).toBe('Lendo app.ts');
    expect(tr('Text nobody translated')).toBe('Text nobody translated');
    expect(intlLocale()).toBe('pt-BR');
    setLocale('es');
    expect(tr('Reading {0}', ['app.ts'])).toBe(ES['Reading {0}'].replace('{0}', 'app.ts'));
    expect(intlLocale()).toBe('es');
  });

  it('no translation is empty, loses placeholders or makes them up', () => {
    for (const [lang, dict] of Object.entries({ 'pt-BR': PT_BR, es: ES, fr: FR })) {
      for (const [en, t] of Object.entries(dict)) {
        expect(t.trim(), `${lang}: ${en}`).not.toBe('');
        const original = placeholders(en);
        for (const p of placeholders(t)) expect(original.has(p), `${lang}: ${en} -> ${t}`).toBe(true);
        if (lang !== 'fr') for (const p of original) expect(placeholders(t).has(p), `${lang}: ${en} -> ${t}`).toBe(true);
      }
    }
  });

  it("browser: the saved choice, else the browser's languages, else English", async () => {
    const pageLocale = async (saved: string | null, languages: string[]) => {
      vi.resetModules();
      vi.stubGlobal('window', {});
      vi.stubGlobal('localStorage', { getItem: () => saved });
      vi.stubGlobal('navigator', { languages });
      try {
        return (await import('./i18n')).getLocale();
      } finally {
        vi.unstubAllGlobals();
      }
    };
    expect(await pageLocale(null, ['de-DE', 'ja'])).toBe('en');
    expect(await pageLocale(null, [])).toBe('en');
    expect(await pageLocale(null, ['de-DE', 'pt-PT', 'en-US'])).toBe('pt-BR');
    expect(await pageLocale(null, ['en-GB', 'fr'])).toBe('en');
    expect(await pageLocale('fr', ['pt-BR'])).toBe('fr');
    expect(await pageLocale('pt-BR', ['en-US'])).toBe('pt-BR');
    expect(await pageLocale('xx', ['es-MX'])).toBe('es');
  });
});
