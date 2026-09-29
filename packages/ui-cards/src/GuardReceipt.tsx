import { GUARANTEE_IDS, type GuaranteeResult, type Plan } from '@cold-reserve/contracts';
import { CardShell } from './CardShell.js';
import { isSimulated } from './plan-model.js';
import { formatMeasure, t } from './text.js';

/** The real home's id; the judges and the demo use simulated homes (plan §9.4, §13.2.1). */
const REAL_HOME_ID = 'home';

/** The guard as a till receipt (signature element 4): all five guarantees, deterministic, no AI. */
export function GuardReceipt({ plan }: { plan: Plan }) {
  const results = GUARANTEE_IDS.map((id) => plan.guarantees.find((g) => g.id === id)).filter((g) => g !== undefined);
  const passed = results.filter((g) => g.ok).length;
  const approved = passed === GUARANTEE_IDS.length;
  const simulated = isSimulated(plan);
  return (
    <CardShell title={t('receipt.heading')} origin={simulated ? 'simulated' : 'live'}>
      <ol className="flow" aria-label={t('receipt.flow')}>
        <li>{t('receipt.proposes')}</li>
        <li data-current="true">{t('receipt.decides')}</li>
        <li>{t('receipt.confirm')}</li>
      </ol>
      {/* Guarantees computed on simulated data are never presented as guarantees about the real home. */}
      {simulated && plan.homeId === REAL_HOME_ID && <p className="warning">{t('receipt.simulatedCaveat')}</p>}
      <div className="receipt">
        <p className="receipt-title">{t('receipt.title', { id: plan.id })}</p>
        <p className="receipt-subtitle">{t('receipt.subtitle')}</p>
        <ul className="receipt-rows" aria-label={t('receipt.list', { id: plan.id })}>
          {results.map((g) => (
            <ReceiptRow key={g.id} result={g} />
          ))}
        </ul>
        <p className="receipt-summary">{t('receipt.summary', { passed: String(passed), total: String(GUARANTEE_IDS.length) })}</p>
        <p className="receipt-stamp" data-approved={approved} data-testid="receipt-stamp">
          {t(approved ? 'receipt.approved' : 'receipt.rejected')}
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
