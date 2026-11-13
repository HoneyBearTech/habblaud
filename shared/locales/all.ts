// All the dictionaries at once: the server, the scripts and the tests use this module. In the browser, vite.config.ts
// swaps it for locales/none.ts, and the client loads only the active language's dictionary (client/src/main.ts).
import type { Locale } from '../i18n';
import { ES } from './es';
import { FR } from './fr';
import { PT_BR } from './pt-BR';

export const DICTIONARIES: Partial<Record<Locale, Readonly<Record<string, string>>>> = { 'pt-BR': PT_BR, es: ES, fr: FR };
