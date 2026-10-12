import { LOCALES, type Locale } from '@cold-reserve/i18n';
import { IconFrame, LanguagesOutline } from '@cold-reserve/ui-cards/icons';
import { useId } from 'react';
import { t } from './text.js';

// The language icon at the top (owner, 10 Oct): English by default, Italian one tap away. One quiet button (never the
// screen's bright action) that offers the other language, written in that language ("Italiano", "English"), so its
// visible label is what it does and what to say; screen readers hear "Language: Italiano". The choice is the same
// per-viewer setting as the drawer's Language row (#263): main.tsx sets and saves it. While the agent still answers in
// English (sim-api ignores the locale), another language gets one quiet line saying so beside the button, which also
// describes the button (pre-review of this change).

/** The language after this one, round the shipped ones. */
export const nextLocale = (locale: Locale): Locale => LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length] ?? 'en-US';

export function LanguageToggle({ locale, onLocale }: { locale: Locale; onLocale: (locale: Locale) => void }) {
  const next = nextLocale(locale);
  const noteId = useId();
  const note = locale !== 'en-US';
  return (
    <>
      {note && (
        <p id={noteId} className="language-top-note" data-testid="language-top-note">
          {t('settings.languageNoteShort')}
        </p>
      )}
      <button
        type="button"
        className="chip-button language-toggle"
        {...(note ? { 'aria-describedby': noteId } : {})}
        onClick={() => {
          onLocale(next);
        }}
      >
        <IconFrame className="language-icon">
          <LanguagesOutline />
        </IconFrame>
        <span className="visually-hidden">{t('settings.language')}:</span>{' '}
        <span className="language-name" lang={next.slice(0, 2)}>{t(`settings.language.${next}`)}</span>
      </button>
    </>
  );
}
