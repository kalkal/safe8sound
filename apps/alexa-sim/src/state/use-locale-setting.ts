import { getLocale, setLocale, subscribeLocale, type Locale } from '@cold-reserve/i18n';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { saveLocale } from '../ui/locale-setting.js';
import { t } from '../ui/text.js';

/** #263: the page's language, this viewer's own setting kept in the browser; every text re-renders with it. */
export function useLocaleSetting(): { locale: Locale; chooseLocale: (next: Locale) => void } {
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  const chooseLocale = useCallback((next: Locale) => {
    setLocale(next);
    saveLocale(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale.slice(0, 2);
    document.title = t('sim.title');
  }, [locale]);
  return { locale, chooseLocale };
}
