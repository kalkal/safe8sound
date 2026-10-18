import { formatTemp, type GetPreferencesOutput, type LocationId, type SetScenarioInput, type TempUnit } from '@cold-reserve/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { LOCALES, isLocale, type Locale } from '@cold-reserve/i18n';
import { roomLabel } from '@cold-reserve/ui-cards';
import { makeRestInert } from '../host/inert.js';
import { HOUSEHOLDS, PLACES, SCENARIOS, badgeText, skyOfScenario, type DemoSettingsView } from './demo-settings.js';
import { chooseSafeRoom, limitsView, mergeChange, moveLimit, withDraft, type LimitChange, type LimitId, type LimitRefusal, type LimitRow } from './limits.js';
import { t } from './text.js';
import './limits.css';

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

function ChipGroup({
  label,
  name,
  options,
  value,
  onPick,
  pending,
}: {
  label: string;
  name: string;
  options: readonly ChipOption[];
  value: string;
  onPick: (value: string) => void;
  /** The choice just tapped, while it is saved (owner, 18 Oct): shown as chosen at once, saying it is being saved. */
  pending?: string | undefined;
}) {
  const labelId = useId();
  const chosen = pending ?? value;
  return (
    <fieldset className="chip-group" role="radiogroup" aria-labelledby={labelId}>
      <legend id={labelId}>{label}</legend>
      {options.map((o) => (
        <label key={o.value} className="chip-row" data-checked={o.value === chosen} data-disabled={o.disabled === true}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === chosen}
            disabled={o.disabled === true}
            onChange={() => {
              onPick(o.value);
            }}
          />
          {o.sky !== undefined && <span className="chip-sky" data-layer={o.sky} aria-hidden="true" />}
          <span className="chip-text">
            <span>{o.label}</span>
            {o.hint !== undefined && <span className="chip-hint">{o.hint}</span>}
            {o.value === pending && <span className="chip-hint">{t('settings.saving')}</span>}
          </span>
          <span className="chip-mark" aria-hidden="true">
            {o.value === chosen ? '✓' : ''}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** One temperature of the section: its name and rule, then "lower", the value and "raise" in 48 px buttons. */
function LimitStepper({ name, hint, value, onMove }: { name: string; hint: string; value: string; onMove: (direction: 'up' | 'down') => void }) {
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
        <output className="limit-value" aria-live="polite">
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

/** How a Save of the limits section ended: `rate_limited` is the demo's daily limit of changes. */
export type LimitSave = 'saved' | 'rate_limited' | 'failed';

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
  /** #402: the home's preferences with their limits, for the temperatures and limits section; undefined until read. */
  limits?: GetPreferencesOutput | undefined;
  /** Saves the draft of the section as one change (the Preferences card's tool): how it ended. */
  onLimit?: ((change: LimitChange) => Promise<LimitSave>) | undefined;
}

export function DemoSettingsControl({ settings, availablePlaces, onChange, locale, onLocale, limits, onLimit }: DemoSettingsControlProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  // #402: why a move in the limits section was not made, said in words under its rows.
  const [refusal, setRefusal] = useState<{ id: LimitId; why: LimitRefusal } | undefined>(undefined);
  const limitsTitleId = useId();
  // #402: the +/- and the choices change a draft; Save sends it as one write.
  const [draft, setDraft] = useState<LimitChange>({});
  const [rateLimited, setRateLimited] = useState(false);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const close = () => {
    setOpen(false);
    setConfirmRestart(false);
    setRefusal(undefined);
    setApplied(undefined);
    // The draft stays: reopening the drawer shows it again with "Not saved yet", so nothing is lost by closing.
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
    const restoreRest = makeRestInert(layerRef.current ?? drawerRef.current);
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

  // A choice of the demo (scenario, place, household, units, restart) says what happened (owner, 18 Oct): the tapped row
  // is chosen at once with "Saving…", then a line at the top says what the demo plays now, or that it was not saved.
  const [pick, setPick] = useState<{ name: string; value: string } | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [applied, setApplied] = useState<'saved' | 'restarted' | 'failed' | undefined>(undefined);
  const send = (change: SetScenarioInput, picked?: { name: string; value: string }) => {
    setPick(picked);
    setSending(true);
    setApplied(undefined);
    void onChange(change).then((saved) => {
      setSending(false);
      setPick(undefined);
      setApplied(saved ? (change.restart === true ? 'restarted' : 'saved') : 'failed');
    });
  };
  const pendingOf = (name: string) => (pick?.name === name ? pick.value : undefined);
  const appliedText =
    sending ? t('settings.saving')
    : applied === 'failed' ? t('settings.failed')
    : applied !== undefined && settings !== undefined
      ? t(applied === 'restarted' ? 'settings.restarted' : 'settings.applied', { place: t(`settings.place.${settings.locationId}`), scenario: t(`settings.scenario.${settings.scenarioId}`) })
      : '';

  const units: TempUnit = settings?.units ?? 'C';
  // What the section shows: the saved preferences with the draft on them.
  const shown = limits === undefined ? undefined : withDraft(limits, draft);
  const model = shown === undefined ? undefined : limitsView(shown);
  const rows = model?.rows ?? [];
  const dirty = Object.keys(draft).length > 0;
  const addToDraft = (change: LimitChange) => {
    setRateLimited(false);
    setDraft((previous) => mergeChange(previous, change));
  };
  const saveDraft = () => {
    if (!dirty || saving) return;
    setSaving(true);
    setFailed(false);
    setRateLimited(false);
    void (onLimit?.(draft) ?? Promise.resolve<LimitSave>('failed')).then((saved) => {
      setSaving(false);
      if (saved === 'saved') setDraft({});
      setFailed(saved === 'failed');
      setRateLimited(saved === 'rate_limited');
    });
  };
  const move = (id: LimitId, direction: 'up' | 'down') => {
    if (shown === undefined) return;
    const result = moveLimit(shown, id, direction);
    setRefusal(result.ok ? undefined : { id, why: result.refusal });
    if (result.ok) addToDraft(result.change);
  };
  const rowsOf = (...ids: LimitId[]) =>
    rows
      .filter((r: LimitRow) => ids.includes(r.id))
      .map((r) => (
        <LimitStepper
          key={r.id}
          name={t(`settings.limits.${r.id}`)}
          hint={t(`settings.limits.${r.id}Hint`, { range: t('settings.limits.range', { min: formatTemp(r.minC, units), max: formatTemp(r.maxC, units) }) })}
          value={formatTemp(r.valueC, units)}
          onMove={(direction) => {
            move(r.id, direction);
          }}
        />
      ));

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
        {settings === undefined ? (
          t('settings.open')
        ) : (
          <>
            {/* The whole badge names the button; a narrow top row shows the scenario alone (app.css), so the row
                stays one target high beside the language icon. */}
            <span className="badge-long">{badgeText(settings)}</span>
            <span className="badge-short" aria-hidden="true">
              {t(`settings.scenario.${settings.scenarioId}`)}
            </span>
          </>
        )}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div ref={layerRef} className="settings-layer">
          {/* The page behind is dimmed and inert (owner, 18 Oct): a tap on it closes the drawer, as Escape does. */}
          <div className="settings-scrim" aria-hidden="true" data-testid="settings-scrim" onClick={close} />
        <div ref={drawerRef} className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
          <div className="settings-head">
            <h2 id={titleId}>{t(settings === undefined ? 'settings.open' : 'settings.title')}</h2>
            <button type="button" className="link-button" onClick={close}>
              {t('settings.close')}
            </button>
          </div>
          {/* Without demo settings there is no demo to change: plain "Settings", no demo intro (review of #290). */}
          {settings !== undefined && <p className="muted">{t('settings.intro')}</p>}
          {settings !== undefined && (
            <p className="notice settings-applied" role="status" data-testid="settings-applied" data-failed={applied === 'failed'}>
              {appliedText}
            </p>
          )}
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
            pending={pendingOf('scenario')}
            options={SCENARIOS.map((id) => ({ value: id, label: t(`settings.scenario.${id}`), sky: skyOfScenario(id) }))}
            onPick={(v) => {
              send({ scenarioId: v as (typeof SCENARIOS)[number] }, { name: 'scenario', value: v });
            }}
          />
          <ChipGroup
            label={t('settings.place')}
            name="place"
            value={settings.locationId}
            pending={pendingOf('place')}
            options={PLACES.map((id) => {
              const available = availablePlaces.includes(id);
              return { value: id, label: t(`settings.place.${id}`), disabled: !available, ...(available ? {} : { hint: t('settings.notYet') }) };
            })}
            onPick={(v) => {
              send({ locationId: v as LocationId }, { name: 'place', value: v });
            }}
          />
          <ChipGroup
            label={t('settings.household')}
            name="household"
            value={settings.household}
            pending={pendingOf('household')}
            options={HOUSEHOLDS.map((h) => ({ value: h, label: t(`settings.household.${h}`) }))}
            onPick={(v) => {
              send({ household: v as (typeof HOUSEHOLDS)[number] }, { name: 'household', value: v });
            }}
          />
          {/* #402: every temperature and limit in one section (it was the units here and the card's setpoints). */}
          <section className="limits" aria-labelledby={limitsTitleId}>
            <h3 id={limitsTitleId}>{t('settings.limits.title')}</h3>
            {shown !== undefined && model !== undefined && (
              <>
                <p className="muted">{t('settings.limits.intro')}</p>
                <ChipGroup
                  label={t('settings.limits.safeRoom')}
                  name="safe-room"
                  value={shown.preferences.safeRoomId}
                  // A steady order by name: the priority order moves the chosen room to the head, and a list that jumps is hard to use.
                  options={shown.preferences.roomPriority.map((id) => ({ value: id, label: shown.rooms?.find((r) => r.id === id)?.name ?? roomLabel(id) })).sort((a, b) => a.label.localeCompare(b.label))}
                  onPick={(id) => {
                    const chosen = chooseSafeRoom(shown, id);
                    if (chosen.ok) addToDraft(chosen.change);
                  }}
                />
                {rowsOf('comfort', 'safeMax')}
              </>
            )}
            <ChipGroup
              label={t('settings.units')}
              name="units"
              value={settings.units}
              pending={pendingOf('units')}
              options={(['C', 'F'] as const).map((u) => ({ value: u, label: t(`settings.units.${u}`) }))}
              onPick={(v) => {
                send({ units: v === 'F' ? 'F' : 'C' }, { name: 'units', value: v });
              }}
            />
            {model !== undefined && (
              <fieldset className="limit-night">
                <legend>{t('settings.limits.night')}</legend>
                <p>{t('settings.limits.nightAdult', { value: formatTemp(model.night.standardC, units) })}</p>
                <p>{t('settings.limits.nightOlder', { value: formatTemp(model.night.elderlyC, units) })}</p>
                <p className="muted">{t('settings.limits.nightSource')}</p>
                <label className="chip-row" data-checked={model.nightEveryPlan}>
                  <input
                    type="checkbox"
                    checked={model.nightEveryPlan}
                    onChange={() => {
                      addToDraft({ safety: { stricterNightLimit: !model.nightEveryPlan } });
                    }}
                  />
                  <span className="chip-text">
                    <span>{t('settings.limits.nightEvery')}</span>
                    <span className="chip-hint">{t('settings.limits.nightEveryHint')}</span>
                  </span>
                  <span className="chip-mark" aria-hidden="true">
                    {model.nightEveryPlan ? '✓' : ''}
                  </span>
                </label>
                {rowsOf('heatIndexCap', 'elderlyCap')}
              </fieldset>
            )}
            {shown !== undefined && (
              <button type="button" className="button" aria-disabled={!dirty || saving} onClick={saveDraft} data-testid="limits-save">
                {t('settings.limits.save')}
              </button>
            )}
            <p className="notice" role="alert" data-testid="limit-refusal">
              {refusal === undefined ? '' : refusalText(refusal.id, refusal.why, units)}
            </p>
          </section>
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
            {saving ? t('settings.saving') : failed ? t('settings.failed') : rateLimited ? t('settings.limits.rateLimited') : dirty ? t('settings.limits.unsaved') : ''}
          </p>
        </div>
        </div>
      )}
    </>
  );
}
