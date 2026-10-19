import type { LocationId, Milestone, MilestoneKind, SetScenarioInput } from '@cold-reserve/contracts';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChipGroup } from '../ui/ChipGroup.js';
import { HOUSEHOLDS, PLACES, SCENARIOS, skyOfScenario, type DemoSettingsView } from '../ui/demo-settings.js';
import { clockTime } from '../ui/sim-clock.js';
import { t } from '../ui/text.js';
import { useModal } from '../ui/use-modal.js';
import { useSettingChange } from '../ui/use-setting-change.js';
import { timelineOf } from './timeline.js';
import './demo-controls.css';

// The judges' demo controls (#432; brief 1 and 3b): outside the Echo, named as a simulation so nobody takes them for
// the product. The weather (the three scenarios, no free sliders), the place, who is at home, the day as a short
// timeline (the current stop marked, the next one named) and Restart the day in two taps. A change shows at once and
// says what the demo plays now. On a wide screen a column beside the Echo; below it a modal sheet behind one button.
// The big "Go to …" button stays on the clock bar under the Echo, so the time and its jump are always in view.

/** Where the demo controls are a column beside the Echo, not a sheet (the Echo layout's CSS uses the same query). */
export const WIDE_CONTROLS = '(width >= 100rem) and (min-aspect-ratio: 2 / 1)';

/** Whether the sheet is open, and the button that opens it (the focus goes back to it). */
export function useDemoControlsSheet() {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return { open, setOpen, opener };
}
type Sheet = ReturnType<typeof useDemoControlsSheet>;

/** What the demo plays now, in words: "Reference home (Italy) · Heat wave". */
const summaryOf = (settings: DemoSettingsView) => t('demoControls.summary', { place: t(`settings.place.${settings.locationId}`), scenario: t(`settings.scenario.${settings.scenarioId}`) });

/**
 * The button of the top bar that opens the sheet (below the wide layout): it also says what the demo plays now, as the
 * scenario badge did, so the judge sees it with the sheet closed. None without demo controls.
 */
export function DemoControlsOpener({ sheet, settings, hidden = false }: { sheet: Sheet; settings: DemoSettingsView | undefined; hidden?: boolean }) {
  if (hidden || settings === undefined) return null;
  return (
    <button
      ref={sheet.opener}
      type="button"
      className="demo-controls-open"
      aria-haspopup="dialog"
      aria-expanded={sheet.open}
      onClick={() => {
        sheet.setOpen(true);
      }}
    >
      {`${t('demoControls.open')} · `}
      <span className="demo-controls-open-summary" data-testid="demo-controls-summary">
        {summaryOf(settings)}
      </span>
      <span aria-hidden="true"> ▾</span>
    </button>
  );
}

export interface DemoControlsPanelProps {
  sheet: Sheet;
  /** A column beside the Echo (wide screens) or a sheet behind the opener. */
  wide: boolean;
  /** The sandbox's settings; without them (not a sandbox) there are no demo controls. */
  settings: DemoSettingsView | undefined;
  availablePlaces: readonly LocationId[];
  onChange: (change: SetScenarioInput) => Promise<boolean>;
  /** The day's stops seen so far and the simulated time (state/use-sim-clock). */
  stops: readonly Milestone[];
  now: string | undefined;
  /** The last jump of the clock: where it went and how many messages Ana got on the way (brief 3b). */
  lastJump?: { at: string; kind: MilestoneKind; told: number } | undefined;
}

export function DemoControlsPanel({ sheet, wide, settings, availablePlaces, onChange, stops, now, lastJump }: DemoControlsPanelProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const { send, pendingOf, appliedText, failed, forget } = useSettingChange(onChange, settings);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const modal = !wide && sheet.open;
  const close = () => {
    sheet.setOpen(false);
    setConfirmRestart(false);
    forget();
  };
  useModal({ open: modal, close, dialog: dialogRef, layer: layerRef, opener: sheet.opener });
  // The second tap of Restart is where the first one was: the focus moves to it.
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmRestart) confirmRef.current?.focus();
  }, [confirmRestart]);
  if (settings === undefined || (!wide && !sheet.open)) return null;

  const line = now === undefined ? undefined : timelineOf(stops, now);
  const body: ReactNode = (
    <>
      <div className="demo-controls-head">
        <h2 id={titleId}>{t('demoControls.title')}</h2>
        {!wide && (
          <button type="button" className="link-button" onClick={close}>
            {t('settings.close')}
          </button>
        )}
      </div>
      <p className="muted">{t('demoControls.intro')}</p>
      {/* One line says what the demo plays, and while a change is saved, that it is, then that it was (or was not). */}
      <p className="demo-controls-summary" role="status" data-testid="demo-controls-summary" data-failed={failed}>
        {appliedText === '' ? summaryOf(settings) : appliedText}
      </p>
      <ChipGroup
        label={t('demoControls.weather')}
        name="scenario"
        value={settings.scenarioId}
        pending={pendingOf('scenario')}
        options={SCENARIOS.map((id) => ({ value: id, label: t(`settings.scenario.${id}`), sky: skyOfScenario(id) }))}
        onPick={(v) => {
          send({ scenarioId: v as (typeof SCENARIOS)[number] }, { name: 'scenario', value: v });
        }}
      />
      {line !== undefined && <DayTimeline line={line} />}
      {/* What the last jump changed, said once it is done; the clock bar keeps its own short status. */}
      <p className="demo-jump" aria-live="polite" data-testid="demo-controls-jump">
        {lastJump === undefined ? '' : jumpText(lastJump)}
      </p>
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
  );
  if (wide) {
    return (
      <section className="demo-controls" aria-labelledby={titleId} data-testid="demo-controls">
        {body}
      </section>
    );
  }
  return (
    <div ref={layerRef} className="settings-layer">
      {/* The page behind is dimmed and inert: a tap on it closes the sheet, as Escape does. */}
      <div className="settings-scrim" aria-hidden="true" data-testid="settings-scrim" onClick={close} />
      <div ref={dialogRef} className="settings-drawer demo-controls" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="demo-controls">
        {body}
      </div>
    </div>
  );
}

/** "15:00 — the grid goes down · Ana got a message": what a jump of the clock changed (brief 3b). */
export function jumpText(jump: { at: string; kind: MilestoneKind; told: number }): string {
  const parts = [t('demoControls.jump', { time: clockTime(jump.at), moment: t(`clock.kind.${jump.kind}`) })];
  if (jump.told === 1) parts.push(t('demoControls.toldOne'));
  if (jump.told > 1) parts.push(t('demoControls.toldMany', { count: String(jump.told) }));
  return parts.join(' · ');
}

/** The day as its stops: each with its time, the current one marked, the next one named under them. */
function DayTimeline({ line }: { line: ReturnType<typeof timelineOf> }) {
  const titleId = useId();
  return (
    <section className="demo-timeline" aria-labelledby={titleId}>
      <h3 id={titleId}>{t('demoControls.day')}</h3>
      <ol aria-labelledby={titleId}>
        {line.stops.map((s, i) => (
          <li key={`${s.kind}@${s.at}`} data-state={i < line.current ? 'past' : i === line.current ? 'current' : 'ahead'} {...(i === line.current ? { 'aria-current': 'step' } : {})}>
            <time dateTime={s.at}>{clockTime(s.at)}</time> {t(`clock.kind.${s.kind}`)}
            {i === line.current && <span className="visually-hidden"> ({t('demoControls.now')})</span>}
          </li>
        ))}
      </ol>
      <p className="demo-timeline-next" data-testid="demo-controls-next">
        {line.next === undefined ? t('demoControls.nothingNext') : t('demoControls.next', { time: clockTime(line.next.at), moment: t(`clock.kind.${line.next.kind}`) })}
      </p>
    </section>
  );
}
