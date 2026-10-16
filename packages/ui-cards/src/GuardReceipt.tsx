import { GUARANTEE_IDS, REAL_HOME_ID, type DataOriginValue, type ErrorEnvelope, type GuaranteeResult, type Plan } from '@cold-reserve/contracts';
import { CardShell } from './CardShell.js';
import { isSimulated } from './plan-model.js';
import { formatMeasure, t } from './text.js';


const SHORT_ID_CHARS = 9;

/** A plan id as a till prints it (design analysis G4): a long one cut to its first characters and "…", never wrapped. */
export const shortId = (id: string): string => (id.length > SHORT_ID_CHARS + 3 ? `${id.slice(0, SHORT_ID_CHARS)}…` : id);

/** The guard as a till receipt (signature element 4): all five guarantees, deterministic, no AI. */
export function GuardReceipt({ plan }: { plan: Plan }) {
  const simulated = isSimulated(plan);
  return (
    <ReceiptView
      guarantees={plan.guarantees}
      title={t('receipt.title', { id: shortId(plan.id) })}
      fullId={plan.id}
      list={t('receipt.list', { id: plan.id })}
      origin={simulated ? 'simulated' : 'live'}
      caveat={simulated && plan.homeId === REAL_HOME_ID}
      lastResort={plan.lastResort !== undefined}
    />
  );
}

/**
 * A plan the guard refused (#186): the receipt from the refusal's own verdict, all five rows, REJECTED. No plan
 * was saved, so it is "the proposed plan"; its data origin and the real-home flag give the badge and the notice.
 */
export function RefusalReceipt({ refusal }: { refusal: ErrorEnvelope }) {
  const origin = refusal.details?.origin;
  // Older refusals carry no origin: no badge is guessed. With it, the same badge and notice as a plan's receipt.
  const simulated = origin !== undefined && Object.values(origin).includes('simulated');
  return (
    <ReceiptView
      guarantees={refusal.details?.guarantees ?? []}
      title={t('receipt.titleProposed')}
      list={t('receipt.listProposed')}
      {...(origin === undefined ? {} : { origin: simulated ? ('simulated' as const) : ('live' as const) })}
      caveat={simulated && refusal.details?.realHome === true}
      lastResort={false}
    />
  );
}

interface ReceiptViewProps {
  guarantees: readonly GuaranteeResult[];
  title: string;
  /** The whole plan id, on hover; screen readers hear it in the list name. */
  fullId?: string;
  list: string;
  origin?: DataOriginValue;
  /** Guarantees computed on simulated data for the real home: said, never presented as about the real home. */
  caveat: boolean;
  lastResort: boolean;
}

function ReceiptView({ guarantees, title, fullId, list, origin, caveat, lastResort }: ReceiptViewProps) {
  const results = GUARANTEE_IDS.map((id) => guarantees.find((g) => g.id === id)).filter((g) => g !== undefined);
  const passed = results.filter((g) => g.ok).length;
  const approved = passed === GUARANTEE_IDS.length;
  // A last resort is offered on purpose when a guarantee cannot hold (#160): it says which, never a bare REJECTED.
  const failed = results.filter((g) => !g.ok).map((g) => t(`guarantee.${g.id}`));
  const stamp = approved ? t('receipt.approved') : lastResort ? t('receipt.lastResort', { failed: failed.join(', ') }) : t('receipt.rejected');
  return (
    <CardShell title={t('receipt.heading')} {...(origin === undefined ? {} : { origin })}>
      <ol className="flow" aria-label={t('receipt.flow')}>
        <li>{t('receipt.proposes')}</li>
        <li data-current="true">{t('receipt.decides')}</li>
        <li>{t('receipt.confirm')}</li>
      </ol>
      {/* Guarantees computed on simulated data are never presented as guarantees about the real home. */}
      {caveat && <p className="warning">{t('receipt.simulatedCaveat')}</p>}
      <div className="receipt">
        <p className="receipt-explain" data-testid="receipt-explain">
          {t(lastResort ? 'receipt.explainLastResort' : 'receipt.explain')}
        </p>
        <p className="receipt-title" data-testid="receipt-title" {...(fullId === undefined ? {} : { title: fullId })}>
          {title}
        </p>
        <p className="receipt-subtitle">{t('receipt.subtitle')}</p>
        <ul className="receipt-rows" aria-label={list}>
          {results.map((g) => (
            <ReceiptRow key={g.id} result={g} />
          ))}
        </ul>
        <p className="receipt-summary">{t('receipt.summary', { passed: String(passed), total: String(GUARANTEE_IDS.length) })}</p>
        <p className="receipt-stamp" data-approved={approved} data-testid="receipt-stamp">
          {stamp}
        </p>
      </div>
    </CardShell>
  );
}

function compare(measured: number, limit: number): string {
  if (measured === limit) return '=';
  return measured > limit ? '>' : '<';
}

/** Guarantees whose passing numbers are said in words (#187): a minimum kept, or a maximum not exceeded. */
const KEPT_KEYS = { storm_reserve: 'receipt.kept.storm_reserve', inverter_limit: 'receipt.kept.inverter_limit', battery_power: 'receipt.kept.battery_power' } as const;

/** The guard rounds the two sides apart by at most one tenth; compared in whole tenths, never in floating point. */
const tenths = (x: number): number => Math.round(x * 10);

/** The numbers of one row. A passing row with a known direction reads as satisfied; the rest keep the plain comparison. */
export function receiptNumbers(result: GuaranteeResult): string[] {
  const { measured, limit, nearestAllowed, unit } = result;
  if (result.ok && measured !== undefined && limit !== undefined && result.id in KEPT_KEYS) {
    const minimum = result.id === 'storm_reserve';
    // The guard rounds the two sides apart (the limit up): a pass within that rounding reads as exactly on the limit, same rounding both sides.
    const shown = tenths(measured) < tenths(limit) && tenths(measured) >= tenths(limit) - 1 ? limit : measured;
    // A battery already below the floor may stay where it is (the plan only must not lower it): said so, never "above".
    if (minimum && tenths(shown) < tenths(limit)) return [t('receipt.kept.storm_reserve_stays', { measured: formatMeasure(shown, unit), limit: formatMeasure(limit, unit) })];
    return [t(KEPT_KEYS[result.id as keyof typeof KEPT_KEYS], { measured: formatMeasure(shown, unit), limit: formatMeasure(limit, unit) })];
  }
  return [
    measured !== undefined && limit !== undefined ? `${formatMeasure(measured, unit)} ${compare(measured, limit)} ${formatMeasure(limit, unit)}` : null,
    nearestAllowed !== undefined ? t('receipt.nearest', { value: formatMeasure(nearestAllowed, unit) }) : null,
  ].filter((part) => part !== null);
}

function ReceiptRow({ result }: { result: GuaranteeResult }) {
  const numbers = receiptNumbers(result);
  return (
    <li className="receipt-row" data-ok={result.ok}>
      <span className="receipt-name" data-testid="guarantee-name">
        {t(`guarantee.${result.id}`)}
      </span>
      <span className="receipt-verdict">
        <span aria-hidden="true">{result.ok ? '✓ ' : '✗ '}</span>
        <span data-testid="guarantee-verdict">{t(result.ok ? 'receipt.pass' : 'receipt.fail')}</span>
      </span>
      <span className="receipt-reason">{result.reason}</span>
      {numbers.length > 0 && <span className="receipt-numbers">{numbers.join(' · ')}</span>}
    </li>
  );
}
