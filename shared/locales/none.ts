// In the browser, in place of locales/all.ts (see vite.config.ts): the active language's dictionary arrives by
// dynamic import in client/src/main.ts, so that not everyone gets all three.
import type { Locale } from '../i18n';

export const DICTIONARIES: Partial<Record<Locale, Readonly<Record<string, string>>>> = {};
