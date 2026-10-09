import { epochMs, formatTemp, tempGap, type Plan } from '@cold-reserve/contracts';
import { useId, useState } from 'react';
import { CardShell } from './CardShell.js';
import { homeClock, isSimulated, levelSpans, pacingGeometry } from './plan-model.js';
import { roomLabel } from './SafeRoomCard.js';
import { getTempUnit } from './temp-unit.js';
import { formatMeasure, t } from './text.js';

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
  // Apply only when the host can run it (onApply given), the plan is proposed and every guarantee passes.
  const applicable = onApply !== undefined && plan.status === 'proposed' && plan.guarantees.every((g) => g.ok);
  // A last resort (#160) has its own button: the first of two steps, never the plain Apply.
  const lastResort = plan.lastResort;
  const lastResortApplicable = onApply !== undefined && plan.status === 'proposed' && lastResort !== undefined;
  // One tap, one call: the buttons wait for the answer, which replaces this card.
  const [sending, setSending] = useState(false);
  return (
    <CardShell title={t('plan.title')} origin={isSimulated(plan) ? 'simulated' : 'live'}>
      {/* The guard refused the model's proposal and this plan holds instead (#202): said first, inside the card. */}
      {plan.refusedProposal !== undefined && (
        <p className="notice" data-testid="refused-proposal">
          {t('plan.refusedProposal', { message: plan.refusedProposal.message })}
        </p>
      )}
      {/* On an ordinary day the headline is where the sun went (video scene 2a): first, before the estimate. */}
      {plan.surplus !== undefined && <SurplusRouting surplus={plan.surplus} timeZone={timeZone} />}
      {lastResort === undefined ? (
        <div className="plan-hero">
          <p className="eyebrow">{t('plan.until')}</p>
          <p className="hero-value" data-testid="plan-horizon">
            {homeClock(plan.horizonAt, timeZone)}
          </p>
          <p className="chip">{t('plan.confidence', { confidence: t(`confidence.${plan.forecastConfidence}`) })}</p>
          <p className="muted">{plan.confidenceReason}</p>
        </div>
      ) : (
        <LastResortHero lastResort={lastResort} timeZone={timeZone} />
      )}
      {/* The ribbon reads as "Comfort … until the horizon": a last resort shows only its honest window. */}
      {lastResort === undefined && <LevelRibbon plan={plan} timeZone={timeZone} />}
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
          <button
            type="button"
            className="button-primary"
            disabled={sending}
            onClick={() => {
              setSending(true);
              onApply(plan.id);
            }}
          >
            {t('plan.apply')}
          </button>
          <button type="button" className="button-secondary" onClick={() => onDismiss?.()}>
            {t('plan.dismiss')}
          </button>
        </div>
      )}
      {lastResortApplicable && (
        <div className="plan-actions">
          <p className="muted">{t('plan.validUntil', { time: homeClock(plan.expiresAt, timeZone) })}</p>
          <button
            type="button"
            className="button-primary"
            disabled={sending}
            onClick={() => {
              setSending(true);
              onApply(plan.id);
            }}
          >
            {t('plan.applyLastResort')}
          </button>
          <button type="button" className="button-secondary" onClick={() => onDismiss?.()}>
            {t('plan.dismiss')}
          </button>
        </div>
      )}
    </CardShell>
  );
}

type Surplus = NonNullable<Plan['surplus']>;

/**
 * Where the solar surplus went instead of the grid (#203, #227): the window, the energy kept at home as the big
 * number, and the rooms in the order they got it, by name, with the reason and the setpoint. Every number is the
 * plan's own, so voice and card say the same.
 */
function SurplusRouting({ surplus, timeZone }: { surplus: Surplus; timeZone: string }) {
  const titleId = useId();
  return (
    <section className="surplus" aria-labelledby={titleId}>
      <h3 id={titleId} className="eyebrow">
        {t('plan.surplusTitle', { from: homeClock(surplus.from, timeZone), to: homeClock(surplus.to, timeZone) })}
      </h3>
      <p className="surplus-kept">
        <span className="hero-value" data-testid="surplus-kept">
          {t('plan.surplusKept', { kwh: surplus.keptKWh.toFixed(1) })}
        </span>
        <span className="muted">{t('plan.surplusKeptNote')}</span>
      </p>
      <ol className="surplus-rooms" aria-label={t('plan.surplusRooms')}>
        {surplus.rooms.map((room) => (
          <li key={room.roomId}>
            <strong>{roomLabel(room.roomId)}</strong>
            <span>
              {surplusRoomText(room, surplus.comfortC)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

type SurplusRoom = NonNullable<Plan['surplus']>['rooms'][number];

/**
 * A surplus room in the chosen unit (°F everywhere, owner decision, 9 Oct): now, the gap and the comfort from the
 * rounded absolutes (now − comfort = gap adds up). Without the comfort, the gap alone, converted as a difference.
 */
function surplusRoomText(room: SurplusRoom, comfortC: number | undefined): string {
  const unit = getTempUnit();
  const reason = t(`surplusReason.${room.reason}`);
  const setpoint = formatTemp(room.setpointC, unit);
  if (comfortC === undefined) {
    const gap = Math.round(Math.abs(room.aboveTargetK) * (unit === 'F' ? 1.8 : 1) * 10) / 10;
    const side = t(room.aboveTargetK >= 0 ? 'surplus.above' : 'surplus.below');
    return t('plan.surplusRoomNoComfort', { reason, setpoint, delta: `${gap.toFixed(1)} °${unit}`, side });
  }
  const g = tempGap(comfortC + room.aboveTargetK, comfortC, unit);
  return t('plan.surplusRoom', {
    reason,
    setpoint,
    now: `${g.now.toFixed(1)} °${unit}`,
    // One decimal for all three: now − comfort = gap always adds up (review of #303).
    comfort: `${g.ref.toFixed(1)} °${unit}`,
    delta: `${g.gap.toFixed(1)} °${unit}`,
    side: t(g.side === 'above' ? 'surplus.above' : 'surplus.below'),
  });
}

type LastResort = NonNullable<Plan['lastResort']>;

/**
 * The headline of a last resort (#160): until when the safe room stays within its limits, then how far past
 * them it goes and by when. Every number from the plan; never a claim about the time after `safeUntil`.
 */
function LastResortHero({ lastResort: lr, timeZone }: { lastResort: LastResort; timeZone: string }) {
  return (
    <div className="plan-hero">
      <p className="eyebrow">{t(lr.limitedBy === 'battery' ? 'plan.lastResortBatteryUntil' : 'plan.lastResortUntil')}</p>
      <p className="hero-value" data-testid="plan-horizon">
        {homeClock(lr.safeUntil, timeZone)}
      </p>
      <p className="warning" data-testid="last-resort-window">
        {lastResortWindow(lr, timeZone)}
      </p>
    </div>
  );
}

function lastResortWindow(lr: LastResort, timeZone: string): string {
  if (lr.comfortLimitC === undefined || lr.worstC === undefined || lr.worstAt === undefined) return t('plan.lastResortNoWindow');
  const until = homeClock(lr.safeUntil, timeZone);
  const time = homeClock(lr.worstAt, timeZone);
  const temp = formatMeasure(lr.worstC, 'C');
  // The worst point is the end of the safe hours itself: "at" that time, never "up to … by" it.
  const atEnd = epochMs(lr.worstAt) === epochMs(lr.safeUntil);
  if (lr.loweredLimitC !== undefined) {
    const limit = formatMeasure(lr.loweredLimitC, 'C');
    return atEnd ? t('plan.lastResortLoweredAtEnd', { until, limit, temp }) : t('plan.lastResortLowered', { until, limit, temp, time });
  }
  const limit = formatMeasure(lr.comfortLimitC, 'C');
  if (atEnd) return t('plan.lastResortAtEnd', { time, temp, limit });
  // Past the limit below it is the heating season.
  return t(lr.worstC < lr.comfortLimitC ? 'plan.lastResortDown' : 'plan.lastResortUp', { temp, time, limit });
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
  const kwh = String(Math.round(plan.reserveWh / 100) / 10);
  let floor = '';
  if (plan.gridAvailable === false) floor = ` ${t('plan.reserveInUse', { kwh })}`;
  else if (floorPct !== undefined) floor = ` ${t('plan.floor', { kwh, pct: String(floorPct) })}`;
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
