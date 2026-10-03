import type { ApplyPlanOutput } from '@cold-reserve/contracts';
import { GuardReceipt } from '../GuardReceipt.js';
import { IceCubesCard } from '../IceCubesCard.js';
import { PlanCard } from '../PlanCard.js';
import { PreferencesCard } from '../PreferencesCard.js';
import { FloorPlanCard } from '../FloorPlanCard.js';
import { ManualControlCard } from '../ManualControlCard.js';
import { SafeRoomCard } from '../SafeRoomCard.js';
import { t } from '../text.js';
import { CardErrorBoundary } from './CardErrorBoundary.js';
import type { CardState } from './card-kinds.js';

export interface CardAppProps {
  state: CardState;
  /** IANA zone from hostContext.timeZone: on an Echo Show at home it is the home's clock. */
  timeZone: string;
  /** False when the host announces no serverTools: Apply and Save are hidden, and the card says so. */
  canAct: boolean;
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

function CardContent({ state, timeZone, canAct, onCallTool }: Omit<CardAppProps, 'notice'>) {
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
            {...(canAct && {
              onApply: (planId: string) => {
                onCallTool('apply_plan', { planId });
              },
            })}
          />
          {!canAct && <p className="muted">{t('card.noActions')}</p>}
          <GuardReceipt plan={state.data} />
        </>
      );
    case 'applied':
      return <AppliedPlan result={state.data} timeZone={timeZone} />;
    case 'reserve':
      return <IceCubesCard outlook={state.data} />;
    case 'storm':
      return <SafeRoomCard status={state.data} />;
    case 'home':
      return <FloorPlanCard status={state.data} />;
    case 'preferences':
      return (
        <>
          <PreferencesCard
            view={state.data}
            {...(canAct && {
              onSave: (change: Parameters<typeof onCallTool>[1]) => {
                onCallTool('set_preferences', change);
              },
            })}
          />
          {!canAct && <p className="muted">{t('card.noActions')}</p>}
        </>
      );
  }
}

function AppliedPlan({ result, timeZone }: { result: ApplyPlanOutput; timeZone: string }) {
  const { plan, alreadyApplied, advisoryOnly, manualInstructions, confirmation } = result;
  // The first yes to a last resort applies nothing (#160): the card must not say "applied".
  // Advice is never "applied": nothing changes in the home, the person does it (plan §11.6).
  const notice =
    confirmation !== undefined ? 'plan.notYetApplied' : advisoryOnly ? 'plan.appliedAsAdvice' : alreadyApplied ? 'plan.alreadyApplied' : 'plan.applied';
  return (
    <>
      <p className="notice" role="status">
        {t(notice)}
      </p>
      {/* The real home is read-only during the hackathon: the splits are set by hand (plan §11.6). */}
      {advisoryOnly && manualInstructions.length > 0 && <ManualControlCard instructions={manualInstructions} reason="read_only" />}
      <PlanCard plan={plan} timeZone={timeZone} />
    </>
  );
}
