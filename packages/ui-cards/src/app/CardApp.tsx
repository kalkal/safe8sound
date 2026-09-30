import type { ApplyPlanOutput } from '@cold-reserve/contracts';
import { GuardReceipt } from '../GuardReceipt.js';
import { IceCubesCard } from '../IceCubesCard.js';
import { PlanCard } from '../PlanCard.js';
import { PreferencesCard } from '../PreferencesCard.js';
import { t } from '../text.js';
import { CardErrorBoundary } from './CardErrorBoundary.js';
import type { CardState } from './card-kinds.js';

export interface CardAppProps {
  state: CardState;
  /** IANA zone from hostContext.timeZone: on an Echo Show at home it is the home's clock. */
  timeZone: string;
  /** A card action is a tool call through the host (MCP Apps callServerTool). */
  onCallTool: (name: string, args: Record<string, unknown>) => void;
  /** The outcome of the last action (e.g. "Preferences saved." or the error in words). */
  notice?: { ok: boolean; text: string };
}

/** The content of one ui:// frame. The host owns the conversation; the card only shows and asks. */
export function CardApp({ notice, ...props }: CardAppProps) {
  return (
    <CardErrorBoundary>
      {notice !== undefined &&
        (notice.ok ? (
          <p className="notice" role="status">
            {notice.text}
          </p>
        ) : (
          <p role="alert">{notice.text}</p>
        ))}
      <CardContent {...props} />
    </CardErrorBoundary>
  );
}

function CardContent({ state, timeZone, onCallTool }: Omit<CardAppProps, 'notice'>) {
  switch (state.kind) {
    case 'waiting':
      return (
        <p className="muted" role="status">
          {t('card.loading')}
        </p>
      );
    case 'error':
      return <p role="alert">{state.message}</p>;
    case 'plan':
      return (
        <>
          <PlanCard
            plan={state.data}
            timeZone={timeZone}
            onApply={(planId) => {
              onCallTool('apply_plan', { planId });
            }}
          />
          <GuardReceipt plan={state.data} />
        </>
      );
    case 'applied':
      return <AppliedPlan result={state.data} timeZone={timeZone} />;
    case 'reserve':
      return <IceCubesCard outlook={state.data} />;
    case 'preferences':
      return (
        <PreferencesCard
          view={state.data}
          onSave={(change) => {
            onCallTool('set_preferences', change);
          }}
        />
      );
  }
}

function AppliedPlan({ result, timeZone }: { result: ApplyPlanOutput; timeZone: string }) {
  const { plan, alreadyApplied, advisoryOnly, manualInstructions } = result;
  return (
    <>
      <p className="notice" role="status">
        {t(alreadyApplied ? 'plan.alreadyApplied' : 'plan.applied')}
      </p>
      {advisoryOnly && manualInstructions.length > 0 && (
        <ul className="manual" aria-label={t('plan.manual')}>
          {manualInstructions.map((m) => (
            <li key={m.roomId}>{m.text}</li>
          ))}
        </ul>
      )}
      <PlanCard plan={plan} timeZone={timeZone} />
    </>
  );
}
