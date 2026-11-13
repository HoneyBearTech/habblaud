// The client's entry point: first the active language's dictionary (only that one goes to the browser), then the app
// (client/src/app.ts), because several modules call tr() when they load. If the dictionary doesn't load, it stays in
// English.
import { getLocale, registerDictionary, type Locale } from '../../shared/i18n';

const LOADERS: Partial<Record<Locale, () => Promise<Readonly<Record<string, string>>>>> = {
  'pt-BR': () => import('../../shared/locales/pt-BR').then((m) => m.PT_BR),
  es: () => import('../../shared/locales/es').then((m) => m.ES),
  fr: () => import('../../shared/locales/fr').then((m) => m.FR),
};

const locale = getLocale();
const load = LOADERS[locale];
const dictionary = load ? load().then((d) => registerDictionary(locale, d)).catch(() => undefined) : Promise.resolve();
void dictionary.then(() => import('./app')).then((app) => app.start());
