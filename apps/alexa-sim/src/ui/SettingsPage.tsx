import { formatTemp, type Household, type TempUnit } from '@cold-reserve/contracts';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { LOCALES, isLocale, type Locale } from '@cold-reserve/i18n';
import { roomLabel } from '@cold-reserve/ui-cards';
import { Avatar } from '@cold-reserve/ui-cards/avatars';
import { BackChevron, IconFrame, SnowflakeOutline } from '@cold-reserve/ui-cards/icons';
import type { LimitId, LimitRefusal, LimitRow } from './limits.js';
import type { SettingsModel } from './settings-model.js';
import { ChipGroup } from './ChipGroup.js';
import { homeFaceOf } from './demo-settings.js';
import { t } from './text.js';
import './limits.css';
import './settings-page.css';

// The person's own settings, a page of the Echo's screen (#432 S5; the judges' demo controls have their own panel):
// "Settings" in the screen's menu opens it in the content band, like "Show my home"; Back, Escape or "Hide settings"
// closes it. Who we protect (read only), then the language, the safe room, the temperatures and limits and the units;
// each choice is one radio group of 56 px rows (ChipGroup), the choice written with a mark, never by colour alone. The
// same page opens on Ana's phone, on the same model (settings-model).

/** One temperature of the section: its name and rule, then "lower", the value and "raise" in 48 px buttons. */
function LimitStepper({ name, hint, value, onMove, announce }: { name: string; hint: string; value: string; onMove: (direction: 'up' | 'down') => void; announce: boolean }) {
  const nameId = useId();
  return (
    <div className="limit-row" role="group" aria-labelledby={nameId}>
      <span className="limit-text">
        <span id={nameId}>{name}</span>
        <span className="chip-hint">{hint}</span>
      </span>
      <span className="limit-stepper">
        <button
          type="button"
          className="limit-step"
          aria-label={t('settings.limits.lower', { name })}
          onClick={() => {
            onMove('down');
          }}
        >
          −
        </button>
        <output className="limit-value" aria-live={announce ? 'polite' : 'off'}>
          {value}
        </output>
        <button
          type="button"
          className="limit-step"
          aria-label={t('settings.limits.raise', { name })}
          onClick={() => {
            onMove('up');
          }}
        >
          +
        </button>
      </span>
    </div>
  );
}

/** A refused move, said in words and in the chosen unit. */
function refusalText(id: LimitId, refusal: LimitRefusal, units: TempUnit): string {
  const value = formatTemp(refusal.limitC, units);
  switch (refusal.kind) {
    case 'looser':
      return t('settings.limits.refusedLooser', { name: t(`settings.limits.${id}`), value });
    case 'ceiling':
      return t('settings.limits.refusedCeiling', { name: t(`settings.limits.${id}`), value });
    case 'floor':
      return t('settings.limits.refusedFloor', { name: t(`settings.limits.${id}`), value });
    case 'comfortAboveMax':
      return t('settings.limits.refusedComfort', { value });
    case 'safeBelowComfort':
      return t('settings.limits.refusedSafeBelowComfort', { value });
  }
}

/** Winter mode comes next (owner, 20 Oct): its own small block after the temperatures and limits, never a switch. */
function WinterNext() {
  const titleId = useId();
  return (
    <section className="settings-winter" aria-labelledby={titleId}>
      <h3 id={titleId}>
        <IconFrame className="settings-winter-icon">
          <SnowflakeOutline className="settings-winter-line" />
        </IconFrame>
        {t('settings.winter.title')}
      </h3>
      <p data-testid="winter-note">{t('settings.limits.winterNext')}</p>
    </section>
  );
}

/**
 * Who the home protects (owner, 18 Oct): fixed and read only until the submission, with the drawn avatars; never a
 * health condition (health data, and the product is never framed as medical protection). Leo's age band is what drives
 * the stricter night limit below (over 65: 24 °C).
 */
function WhoWeProtect({ household }: { household: Household | undefined }) {
  const face = homeFaceOf(household);
  const titleId = useId();
  return (
    <section className="settings-protect" aria-labelledby={titleId}>
      <h3 id={titleId}>{t('settings.protect.title')}</h3>
      <ul>
        <li>
          <Avatar kind={face.avatar} className="settings-avatar" decorative />
          <span>{t(face.who)}</span>
        </li>
        <li>
          <Avatar kind="adult-woman" className="settings-avatar" />
          <span>{t('settings.protect.ana')}</span>
        </li>
      </ul>
    </section>
  );
}

export interface SettingsPageProps {
  model: SettingsModel;
  /** #263: the page's language, a setting of this viewer only (never sent to the sandbox). */
  locale: Locale;
  onLocale: (locale: Locale) => void;
  /**
   * Whether this view's lines are live regions (default true). Two views open at once (the Echo's page and Ana's
   * phone) show the same lines, and only one may announce them, or a screen reader says each twice.
   */
  announce?: boolean;
}

/**
 * Whether a view of the settings page announces its lines: exactly one does while both are on screen. The Echo's page,
 * unless Ana's phone is a modal sheet over it (the page behind is inert); Ana's page while the Echo's is closed or
 * under her sheet.
 */
export function settingsAnnounce(view: 'echo' | 'phone', o: { readonly echoOpen: boolean; readonly phoneModal: boolean }): boolean {
  return view === 'echo' ? !o.phoneModal : !o.echoOpen || o.phoneModal;
}

/** The page itself, one per view (the Echo's screen, Ana's phone): a region named by its title. */
export function SettingsPage({ model, locale, onLocale, announce = true }: SettingsPageProps) {
  const titleId = useId();
  const limitsTitleId = useId();
  // One radio name per view: two views open at once (the Echo's page and the phone's) are two groups, not one.
  const names = useId();
  const { settings, units, shown, view, refusal } = model;
  // Leo's home only while he is at home (homeFaceOf); with no one at risk the page names your home (owner, 21 Oct).
  const named = homeFaceOf(settings?.household).named;
  const rowsOf = (...ids: LimitId[]) =>
    (view?.rows ?? [])
      .filter((r: LimitRow) => ids.includes(r.id))
      .map((r) => (
        <LimitStepper
          key={r.id}
          announce={announce}
          name={t(`settings.limits.${r.id}`)}
          hint={t(`settings.limits.${r.id}Hint`, { range: t('settings.limits.range', { min: formatTemp(r.minC, units), max: formatTemp(r.maxC, units) }) })}
          value={formatTemp(r.valueC, units)}
          onMove={(direction) => {
            model.move(r.id, direction);
          }}
        />
      ));

  return (
    <section className="settings-page" aria-labelledby={titleId} tabIndex={-1} data-testid="settings-page">
      <h2 id={titleId}>{t(named ? 'settings.page.title' : 'settings.page.titleHome')}</h2>
      <WhoWeProtect household={model.settings?.household} />
      {settings !== undefined && (
        <p className="notice settings-applied" role={announce ? 'status' : undefined} data-testid="settings-applied" data-failed={model.unitFailed}>
          {model.unitText}
        </p>
      )}
      {/* Without demo settings (not a sandbox, or not read yet) only the language can be chosen (#284). */}
      {settings !== undefined && (
        // #402: every temperature and limit in one section.
        <section className="limits" aria-labelledby={limitsTitleId}>
          <h3 id={limitsTitleId}>{t('settings.limits.title')}</h3>
          {shown !== undefined && view !== undefined && (
            <>
              <p className="muted">{t('settings.limits.intro')}</p>
              <ChipGroup
                label={t('settings.limits.safeRoom')}
                name={`${names}-safe-room`}
                value={shown.preferences.safeRoomId}
                // A steady order by name: the priority order moves the chosen room to the head, and a list that jumps is hard to use.
                options={shown.preferences.roomPriority.map((id) => ({ value: id, label: shown.rooms?.find((r) => r.id === id)?.name ?? roomLabel(id) })).sort((a, b) => a.label.localeCompare(b.label))}
                onPick={model.pickSafeRoom}
              />
              {rowsOf('comfort', 'safeMax')}
            </>
          )}
          <ChipGroup
            label={t('settings.units')}
            name={`${names}-units`}
            value={settings.units}
            pending={model.unitPending}
            options={(['C', 'F'] as const).map((u) => ({ value: u, label: t(`settings.units.${u}`) }))}
            onPick={model.pickUnits}
          />
          {view !== undefined && (
            <fieldset className="limit-night">
              <legend>{t('settings.limits.night')}</legend>
              <p>{t('settings.limits.nightAdult', { value: formatTemp(view.night.standardC, units) })}</p>
              <p>{t('settings.limits.nightOlder', { value: formatTemp(view.night.elderlyC, units) })}</p>
              <p className="muted">{t('settings.limits.nightSource')}</p>
              <label className="chip-row" data-checked={view.nightEveryPlan}>
                <input type="checkbox" checked={view.nightEveryPlan} onChange={model.toggleNightEveryPlan} />
                <span className="chip-text">
                  <span>{t('settings.limits.nightEvery')}</span>
                  <span className="chip-hint">{t('settings.limits.nightEveryHint')}</span>
                </span>
                <span className="chip-mark" aria-hidden="true">
                  {view.nightEveryPlan ? '✓' : ''}
                </span>
              </label>
              {rowsOf('heatIndexCap', 'elderlyCap')}
            </fieldset>
          )}
          {shown !== undefined && (
            <button type="button" className="button" aria-disabled={!model.dirty || model.saving} onClick={model.save} data-testid="limits-save">
              {t(model.justSaved ? 'settings.limits.saved' : 'settings.limits.save')}
            </button>
          )}
          <p className="notice" role={announce ? 'alert' : undefined} data-testid="limit-refusal">
            {refusal === undefined ? '' : refusalText(refusal.id, refusal.why, units)}
          </p>
        </section>
      )}
      {/* Owner, 20 Oct: honest about what the demo does not cover yet, in a block of its own, plain text, no switch. */}
      <WinterNext />
      <p className="notice" role={announce ? 'status' : undefined}>
        {model.status === undefined ? '' : t(model.status === 'rateLimited' ? 'settings.limits.rateLimited' : model.status === 'unsaved' ? 'settings.limits.unsaved' : `settings.${model.status}`)}
      </p>
      {/* The brief's order (18 Oct): the home's safe room and limits first, then the language. */}
      <ChipGroup
        label={t('settings.language')}
        name={`${names}-language`}
        value={locale}
        options={LOCALES.map((l) => ({ value: l, label: t(`settings.language.${l}`) }))}
        onPick={(v) => {
          if (isLocale(v)) onLocale(v);
        }}
      />
      {/* Until the agent answers in the chosen language (#263 server side), the page says so (main's decision). */}
      {locale !== 'en-US' && (
        <p className="notice" data-testid="language-note">
          {t('settings.languageNote')}
        </p>
      )}
      <p className="muted settings-saved-for">{t(named ? 'settings.savedFor' : 'settings.savedForHome')}</p>
    </section>
  );
}

export interface UseSettingsPageInput {
  model: SettingsModel;
  /** Draws the page (SettingsPage with the viewer's language). */
  render: () => ReactNode;
  /** Each time the page opens, tapped or said: the other page of the screen (the home) closes. */
  onShow?: () => void;
  /** Escape closed the page while its button is not on the page (it sits in the screen's closed menu). */
  onFocusLost?: () => void;
}

/**
 * The page on the Echo's screen, as useHomePanel: the menu's button ("Settings" / "Hide settings"), the page for the
 * content band (null while closed), and open / close for the said commands and for the content band's Back. `isOpen`: whether it
 * is on screen, so another view of the same model knows it must not announce its lines too.
 */
export function useSettingsPage({ model, render, onShow, onFocusLost }: UseSettingsPageInput): { button: ReactElement; view: ReactElement | null; isOpen: boolean; open: () => void; close: () => void } {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // Opened by a tap, the focus moves to the page (the menu that held the button closes); said, it stays where it was.
  const focusOnOpen = useRef(false);
  const { leave } = model;
  // Only a page that was open forgets its last line: a new answer closing a shut page leaves Ana's page as it is.
  const close = useCallback(() => {
    if (!open) return;
    setOpen(false);
    leave();
  }, [open, leave]);
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    hostRef.current?.querySelector<HTMLElement>('.settings-page')?.focus();
  }, [open]);
  // Escape and the Back at the top of the page leave it the same way: closed, the focus back where it was opened from.
  const leavePage = () => {
    close();
    if (buttonRef.current === null) onFocusLost?.();
    else buttonRef.current.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    leavePage();
  };
  const button = (
    <button
      ref={buttonRef}
      type="button"
      className="chip-button"
      aria-expanded={open}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (open) {
          close();
          return;
        }
        onShow?.();
        focusOnOpen.current = true;
        setOpen(true);
      }}
    >
      {t(open ? 'settings.page.hide' : 'settings.open')}
    </button>
  );
  const view = open ? (
    <div ref={hostRef} className="settings-page-host" onKeyDown={onKeyDown}>
      {/* Always at the top left, first on the page (owner, 21 Oct: after saving she could not find the way out; the Echo
          Show's back arrow sits there): it leaves the page as Escape does. */}
      <button type="button" className="chip-button settings-back" data-testid="settings-back" onClick={leavePage}>
        <IconFrame className="settings-back-svg">
          <BackChevron />
        </IconFrame>
        {t('nav.back')}
      </button>
      {render()}
    </div>
  ) : null;
  // Every button sayable (idea 4): saying "Settings" does what tapping it does.
  const show = useCallback(() => {
    onShow?.();
    setOpen(true);
  }, [onShow]);
  return { button, view, isOpen: open, open: show, close };
}
