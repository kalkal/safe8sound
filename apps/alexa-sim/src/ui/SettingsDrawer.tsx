import type { LocationId, SetScenarioInput } from '@cold-reserve/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { LOCALES, isLocale, type Locale } from '@cold-reserve/i18n';
import { makeRestInert } from '../host/inert.js';
import { HOUSEHOLDS, PLACES, SCENARIOS, badgeText, skyOfScenario, type DemoSettingsView } from './demo-settings.js';
import { t } from './text.js';

// B1 (additions plan): the scenario badge, outside the 16:10 screen, opens the judge's settings drawer: a modal
// dialog at the side on a wide screen, a sheet from the bottom on a phone. Each setting is one radio group of 56 px
// rows (the shared Chip), the choice written with a mark, never by colour alone; a place that has not shipped says so.
// Restart takes two taps. Escape closes it and the focus goes back to the badge.

interface ChipOption {
  value: string;
  label: string;
  /** Written under the label, e.g. "Not available yet". */
  hint?: string;
  disabled?: boolean;
  /** A sample of the scenario's sky (decoration). */
  sky?: string;
}

function ChipGroup({ label, name, options, value, onPick }: { label: string; name: string; options: readonly ChipOption[]; value: string; onPick: (value: string) => void }) {
  const labelId = useId();
  return (
    <fieldset className="chip-group" role="radiogroup" aria-labelledby={labelId}>
      <legend id={labelId}>{label}</legend>
      {options.map((o) => (
        <label key={o.value} className="chip-row" data-checked={o.value === value} data-disabled={o.disabled === true}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            disabled={o.disabled === true}
            onChange={() => {
              onPick(o.value);
            }}
          />
          {o.sky !== undefined && <span className="chip-sky" data-layer={o.sky} aria-hidden="true" />}
          <span className="chip-text">
            <span>{o.label}</span>
            {o.hint !== undefined && <span className="chip-hint">{o.hint}</span>}
          </span>
          <span className="chip-mark" aria-hidden="true">
            {o.value === value ? '✓' : ''}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export interface DemoSettingsControlProps {
  /** The sandbox's settings; undefined when there are none (not a sandbox, or not read yet): language only (#284). */
  settings: DemoSettingsView | undefined;
  /** The places this server can play now; the others say "Not available yet". */
  availablePlaces: readonly LocationId[];
  /** Sends one change; resolves true when it was saved. */
  onChange: (change: SetScenarioInput) => Promise<boolean>;
  /** #263: the page's language, a setting of this viewer only (never sent to the sandbox). */
  locale: Locale;
  onLocale: (locale: Locale) => void;
}

export function DemoSettingsControl({ settings, availablePlaces, onChange, locale, onLocale }: DemoSettingsControlProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const close = () => {
    setOpen(false);
    setConfirmRestart(false);
  };
  // Back to the badge once the page is no longer inert (the inert effect's cleanup runs first).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open && wasOpen.current) badgeRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  // A modal dialog: the rest of the page is inert while it shows; the focus starts inside it.
  useEffect(() => {
    if (!open || drawerRef.current === null) return undefined;
    drawerRef.current.focus();
    const restoreRest = makeRestInert(drawerRef.current);
    // Escape closes it wherever the focus is, even after the tapped button went away (Restart → its confirmation).
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onEscape);
      restoreRest();
    };
  }, [open]);
  // The second tap of Restart is where the first one was: the focus moves to it.
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmRestart) confirmRef.current?.focus();
  }, [confirmRestart]);

  const send = (change: SetScenarioInput) => {
    setSaving(true);
    setFailed(false);
    void onChange(change).then((saved) => {
      setSaving(false);
      setFailed(!saved);
    });
  };

  return (
    <>
      <button
        ref={badgeRef}
        type="button"
        className="scenario-badge"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
        }}
      >
        <span aria-hidden="true">≈ </span>
        {settings === undefined ? t('settings.open') : badgeText(settings)}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div ref={drawerRef} className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
          <div className="settings-head">
            <h2 id={titleId}>{t('settings.title')}</h2>
            <button type="button" className="link-button" onClick={close}>
              {t('settings.close')}
            </button>
          </div>
          <p className="muted">{t('settings.intro')}</p>
          <ChipGroup
            label={t('settings.language')}
            name="language"
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
          {/* Without demo settings (not a sandbox, or not read yet) only the language can be chosen (#284). */}
          {settings !== undefined && (
          <>
          <ChipGroup
            label={t('settings.scenario')}
            name="scenario"
            value={settings.scenarioId}
            options={SCENARIOS.map((id) => ({ value: id, label: t(`settings.scenario.${id}`), sky: skyOfScenario(id) }))}
            onPick={(v) => {
              send({ scenarioId: v as (typeof SCENARIOS)[number] });
            }}
          />
          <ChipGroup
            label={t('settings.place')}
            name="place"
            value={settings.locationId}
            options={PLACES.map((id) => {
              const available = availablePlaces.includes(id);
              return { value: id, label: t(`settings.place.${id}`), disabled: !available, ...(available ? {} : { hint: t('settings.notYet') }) };
            })}
            onPick={(v) => {
              send({ locationId: v as LocationId });
            }}
          />
          <ChipGroup
            label={t('settings.units')}
            name="units"
            value={settings.units}
            options={(['C', 'F'] as const).map((u) => ({ value: u, label: t(`settings.units.${u}`) }))}
            onPick={(v) => {
              send({ units: v === 'F' ? 'F' : 'C' });
            }}
          />
          <ChipGroup
            label={t('settings.household')}
            name="household"
            value={settings.household}
            options={HOUSEHOLDS.map((h) => ({ value: h, label: t(`settings.household.${h}`) }))}
            onPick={(v) => {
              send({ household: v as (typeof HOUSEHOLDS)[number] });
            }}
          />
          <div className="settings-restart">
            {confirmRestart ? (
              <>
                <p>{t('settings.restartAsk')}</p>
                <button
                  ref={confirmRef}
                  type="button"
                  className="button"
                  onClick={() => {
                    setConfirmRestart(false);
                    send({ restart: true });
                  }}
                >
                  {t('settings.restartConfirm')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="chip-button"
                onClick={() => {
                  setConfirmRestart(true);
                }}
              >
                {t('settings.restart')}
              </button>
            )}
          </div>
          </>
          )}
          <p className="notice" role="status">
            {saving ? t('settings.saving') : failed ? t('settings.failed') : ''}
          </p>
        </div>
      )}
    </>
  );
}
