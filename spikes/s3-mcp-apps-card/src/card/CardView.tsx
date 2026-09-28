import { useId, type CSSProperties } from 'react';
import { LEVELS, type Level, type Plan } from './plan.js';
import type { CardState } from './tool-result.js';

const LEVEL_LABEL: Record<Level, string> = { comfort: 'Comfort', balanced: 'Balanced', saver: 'Saver', essential: 'Essential' };

function Cubes({ hours }: { hours: number }) {
  const full = Math.floor(hours);
  const part = Math.round((hours - full) * 100) / 100;
  return (
    <div className="cubes" role="img" aria-label={`${hours} hours of reserve at the current level`}>
      {Array.from({ length: full }, (_, i) => (
        <span key={i} className="cube" data-cube="full" />
      ))}
      {part > 0 && <span className="cube" data-cube="partial" style={{ '--cube-part': part } as CSSProperties} />}
    </div>
  );
}

function PlanCard({ plan, onApply }: { plan: Plan; onApply?: (() => void) | undefined }) {
  const reasonId = useId();
  return (
    <article className="card" data-level={plan.level}>
      <header className="card-head">
        {plan.storm && (
          <p className="storm-banner">
            <span aria-hidden="true">⛈</span> Storm mode · grid down since {plan.stormSince ?? 'now'}
          </p>
        )}
        <span className={`badge badge-${plan.dataOrigin}`}>{plan.dataOrigin === 'live' ? 'LIVE' : 'SIMULATED'}</span>
      </header>

      <h1 className="hero">
        <span className="hero-lead">Comfortable at least until</span> <span className="hero-time">{plan.until}</span>
      </h1>
      <p className="estimate">
        <span className="tag">Estimate</span>
        <span className="confidence" data-confidence={plan.confidence}>
          Confidence: {plan.confidence}
        </span>
      </p>
      <p className="reason">{plan.confidenceReason}</p>

      <ol className="levels" aria-label="Levels">
        {LEVELS.map((level) => (
          <li key={level} data-level={level} aria-current={level === plan.level ? 'true' : undefined}>
            {LEVEL_LABEL[level]}
          </li>
        ))}
      </ol>

      <section className="reserve">
        <Cubes hours={plan.reserveHours} />
        <p className="caption">One cube is one hour at the current level.</p>
      </section>

      <section className="receipt">
        <ul aria-label="Guarantees">
          {plan.guarantees.map((g) => (
            <li key={g.id} data-ok={g.ok}>
              <span className="receipt-label">{g.label}</span>
              <span className="receipt-value">{g.value}</span>
              <span className="receipt-verdict">{g.ok ? 'PASS' : 'FAIL'}</span>
            </li>
          ))}
        </ul>
        <p className="caption">Checked by the guard · no AI in this check</p>
      </section>

      <footer className="actions">
        <button
          type="button"
          className="button-primary"
          disabled={!plan.applyAllowed}
          aria-describedby={plan.applyAllowed ? undefined : reasonId}
          onClick={onApply}
        >
          Apply plan
        </button>
        {!plan.applyAllowed && plan.applyBlockedReason && (
          <p id={reasonId} className="caption">
            {plan.applyBlockedReason}
          </p>
        )}
      </footer>
    </article>
  );
}

export function CardView({ state, onApply }: { state: CardState; onApply?: () => void }) {
  if (state.kind === 'waiting') {
    return (
      <div className="card card-quiet" role="status">
        Preparing the plan…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="card card-quiet" role="alert">
        <p>{state.message}</p>
        <p className="caption">{state.retryable ? 'Try again in a minute.' : 'Ask again, or check the house directly.'}</p>
      </div>
    );
  }
  return <PlanCard plan={state.plan} onApply={onApply} />;
}
