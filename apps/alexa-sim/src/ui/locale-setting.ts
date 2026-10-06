import { isLocale, type Locale } from '@cold-reserve/i18n';
import { log } from '../log.js';

// #263: the chosen language is a per-viewer page setting, kept in the browser. Storage can be missing or throw
// (private window, blocked site data): the page then starts in English and the choice lasts for this visit only.

const KEY = 'cold-reserve.locale';

export function readLocale(): Locale {
  try {
    const saved = globalThis.localStorage.getItem(KEY);
    return isLocale(saved) ? saved : 'en-US';
  } catch (error) {
    log({ level: 'warn', code: 'storage_unavailable', error, details: { step: 'read_locale' } });
    return 'en-US';
  }
}

export function saveLocale(locale: Locale): void {
  try {
    globalThis.localStorage.setItem(KEY, locale);
  } catch (error) {
    // Not saved: the choice still applies until the page is closed.
    log({ level: 'warn', code: 'storage_unavailable', error, details: { step: 'save_locale' } });
  }
}
