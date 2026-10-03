import { GUARANTEE_IDS, REAL_HOME_ID, type DataOriginValue, type ErrorEnvelope, type GuaranteeResult, type Plan } from '@cold-reserve/contracts';
import { CardShell } from './CardShell.js';
import { isSimulated } from './plan-model.js';
import { formatMeasure, t } from './text.js';


/** The guard as a till receipt (signature element 4): all five guarantees, deterministic, no AI. */
export function GuardReceipt({ plan }: { plan: Plan }) {
  const simulated = isSimulated(plan);
  return (
    <ReceiptView
      guarantees={plan.guarantees}
      title={t('receipt.title', { id: plan.id })}
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
  list: string;
  origin?: DataOriginValue;
  /** Guarantees computed on simulated data for the real home: said, never presented as about the real home. */
  caveat: boolean;
  lastResort: boolean;
}

function ReceiptView({ guarantees, title, list, origin, caveat, lastResort }: ReceiptViewProps) {
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
        <p className="receipt-title">{title}</p>
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

function ReceiptRow({ result }: { result: GuaranteeResult }) {
  const { measured, limit, nearestAllowed, unit } = result;
  const numbers = [
    measured !== undefined && limit !== undefined ? `${formatMeasure(measured, unit)} ${compare(measured, limit)} ${formatMeasure(limit, unit)}` : null,
    nearestAllowed !== undefined ? t('receipt.nearest', { value: formatMeasure(nearestAllowed, unit) }) : null,
  ].filter((part) => part !== null);
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
