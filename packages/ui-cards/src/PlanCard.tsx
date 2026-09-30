import { epochMs, type Plan } from '@cold-reserve/contracts';
import { CardShell } from './CardShell.js';
import { homeClock, isSimulated, levelSpans, pacingGeometry } from './plan-model.js';
import { t } from './text.js';

export interface PlanCardProps {
  plan: Plan;
  /** IANA time zone of the home (home profile `location.tz`): every time is shown on the home's clock. */
  timeZone: string;
  /** Usable battery energy: draws the reserve floor only when the plan has no `reserveFloorSocPct`. */
  batteryUsableWh?: number;
  onApply?: (planId: string) => void;
  onDismiss?: () => void;
}

/** The hot-day plan (screen S1/plan, Signature mockup): estimate first, then the ribbon and the charge line. */
export function PlanCard({ plan, timeZone, batteryUsableWh, onApply, onDismiss }: PlanCardProps) {
  // The guard never modifies a plan: a rejected one can be read, never applied.
  const applicable = plan.status === 'proposed' && plan.guarantees.every((g) => g.ok);
  return (
    <CardShell title={t('plan.title')} origin={isSimulated(plan) ? 'simulated' : 'live'}>
      <div className="plan-hero">
        <p className="eyebrow">{t('plan.until')}</p>
        <p className="hero-value" data-testid="plan-horizon">
          {homeClock(plan.horizonAt, timeZone)}
        </p>
        <p className="chip">{t('plan.confidence', { confidence: t(`confidence.${plan.forecastConfidence}`) })}</p>
        <p className="muted">{plan.confidenceReason}</p>
      </div>
      <LevelRibbon plan={plan} timeZone={timeZone} />
      <PacingLine plan={plan} timeZone={timeZone} batteryUsableWh={batteryUsableWh} />
      {(plan.warnings ?? []).map((w) => (
        <p key={w.code} className="warning" role="note">
          {w.message}
        </p>
      ))}
      {plan.advisoryOnly && <p className="muted">{t('plan.advisory')}</p>}
      {applicable && (
        <div className="plan-actions">
          <p className="muted">{t('plan.validUntil', { time: homeClock(plan.expiresAt, timeZone) })}</p>
          <button type="button" className="button-primary" onClick={() => onApply?.(plan.id)}>
            {t('plan.apply')}
          </button>
          <button type="button" className="button-secondary" onClick={() => onDismiss?.()}>
            {t('plan.dismiss')}
          </button>
        </div>
      )}
    </CardShell>
  );
}

function LevelRibbon({ plan, timeZone }: { plan: Plan; timeZone: string }) {
  return (
    <ol className="ribbon" aria-label={t('plan.ribbon')}>
      {levelSpans(plan, timeZone).map((span) => (
        <li key={span.level} className="rung" data-level={span.level} data-current={span.current} aria-current={span.current || undefined}>
          <span className="rung-name">{t(`level.${span.level}`)}</span>
          {span.current && <span className="rung-now">{t('plan.now')}</span>}
          <span className="rung-span">{span.from === null || span.to === null ? t('plan.notNeeded') : t('plan.span', { from: span.from, to: span.to })}</span>
        </li>
      ))}
    </ol>
  );
}

function PacingLine({ plan, timeZone, batteryUsableWh }: { plan: Plan; timeZone: string; batteryUsableWh: number | undefined }) {
  const { points, floorPct } = pacingGeometry(plan, batteryUsableWh);
  const steps = [...plan.steps].sort((a, b) => epochMs(a.ts) - epochMs(b.ts));
  const first = steps[0];
  const last = steps.at(-1);
  if (first === undefined || last === undefined) return null;
  const floor =
    floorPct === undefined ? '' : ` ${t('plan.floor', { kwh: String(Math.round(plan.reserveWh / 100) / 10), pct: String(floorPct) })}`;
  const label =
    t('plan.chart', {
      from: String(first.batteryTargetSocPct),
      fromTime: homeClock(first.ts, timeZone),
      to: String(last.batteryTargetSocPct),
      toTime: homeClock(last.ts, timeZone),
    }) + floor;
  return (
    <figure className="pacing">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={label}>
        <line className="pacing-grid" x1="0" x2="100" y1="50" y2="50" vectorEffect="non-scaling-stroke" />
        {floorPct !== undefined && (
          <line data-part="floor" className="pacing-floor" x1="0" x2="100" y1={100 - floorPct} y2={100 - floorPct} vectorEffect="non-scaling-stroke" />
        )}
        {points.map((p, i) => (
          // A zero-length round-capped segment stays a round dot in the stretched chart.
          <line key={i} className="pacing-point" x1={p.x} x2={p.x} y1={p.y} y2={p.y} vectorEffect="non-scaling-stroke" />
        ))}
        <polyline className="pacing-charge" points={points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="pacing-axis" aria-hidden="true">
        <span>{homeClock(plan.createdAt, timeZone)}</span>
        <span>{homeClock(plan.horizonAt, timeZone)}</span>
      </figcaption>
      {floor !== '' && <p className="muted">{floor.trim()}</p>}
    </figure>
  );
}
