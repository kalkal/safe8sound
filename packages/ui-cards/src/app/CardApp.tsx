import type { ApplyPlanOutput } from '@cold-reserve/contracts';
import { useEffect, useRef, useState } from 'react';
import { GuardReceipt, RefusalReceipt } from '../GuardReceipt.js';
import { IceCubesCard } from '../IceCubesCard.js';
import { PlanCard } from '../PlanCard.js';
import { PreferencesCard } from '../PreferencesCard.js';
import { FloorPlanCard } from '../FloorPlanCard.js';
import { ManualControlCard } from '../ManualControlCard.js';
import { SafeRoomCard } from '../SafeRoomCard.js';
import { homeClock } from '../plan-model.js';
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
    case 'refused':
      return (
        <>
          <p role="alert">{t('plan.refused', { message: state.data.message })}</p>
          {state.data.details?.alternative !== undefined && (
            <p className="notice" data-testid="refusal-alternative">
              {t('plan.alternative', { level: t(`level.${state.data.details.alternative.level}`), time: homeClock(state.data.details.alternative.until, timeZone) })}
            </p>
          )}
          <RefusalReceipt refusal={state.data} />
        </>
      );
    case 'applied':
      return (
        <AppliedPlan
          result={state.data}
          timeZone={timeZone}
          fromThisFrame={state.fromThisFrame === true}
          canConfirm={canAct && state.fromThisFrame === true}
          onConfirm={(args) => {
            onCallTool('apply_plan', args);
          }}
        />
      );
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

interface AppliedPlanProps {
  result: ApplyPlanOutput;
  timeZone: string;
  /** The answer to this frame's own tap (not a voice turn's card). */
  fromThisFrame: boolean;
  /** The host can run card actions and this frame made the first step itself. */
  canConfirm: boolean;
  /** The second step of a last resort: apply_plan with the token the first step returned. */
  onConfirm: (args: { planId: string; lastResortToken: string }) => void;
}

function AppliedPlan({ result, timeZone, fromThisFrame, canConfirm, onConfirm }: AppliedPlanProps) {
  const [sending, setSending] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  // The answer replaces the button the person tapped: focus goes to what it says. A voice turn's card never
  // takes the focus from the Ask box.
  useEffect(() => {
    if (fromThisFrame) noticeRef.current?.focus();
  }, [fromThisFrame]);
  const { plan, alreadyApplied, advisoryOnly, manualInstructions, confirmation, familyAlert } = result;
  // The first yes to a last resort applies nothing (#160): the card must not say "applied".
  // Advice is never "applied": nothing changes in the home, the person does it (plan §11.6).
  const confirmLabel = t('plan.confirmLastResort');
  let notice: string;
  if (confirmation === undefined) notice = t(advisoryOnly ? 'plan.appliedAsAdvice' : alreadyApplied ? 'plan.alreadyApplied' : 'plan.applied');
  else {
    const time = homeClock(confirmation.expiresAt, timeZone);
    notice = canConfirm ? t('plan.notYetAppliedTap', { button: confirmLabel, time }) : t('plan.notYetApplied', { time });
  }
  return (
    <>
      {/* CE-22: the notice, the second step and the family alert in one card. */}
      <div className="card">
      <p className="notice" role="status" tabIndex={-1} ref={noticeRef}>
        {notice}
      </p>
      {/* The token stays in this frame's memory: it is sent back, never shown or logged. */}
      {confirmation !== undefined && canConfirm && (
        <div className="plan-actions">
          <button
            type="button"
            className="button-primary"
            disabled={sending}
            onClick={() => {
              setSending(true);
              onConfirm({ planId: plan.id, lastResortToken: confirmation.token });
            }}
          >
            {confirmLabel}
          </button>
        </div>
      )}
      {familyAlert !== undefined && <FamilyAlert sent={familyAlert.sent} failed={familyAlert.failed} />}
      </div>
      {/* The real home is read-only during the hackathon: the splits are set by hand (plan §11.6). */}
      {advisoryOnly && manualInstructions.length > 0 && <ManualControlCard instructions={manualInstructions} reason="read_only" />}
      <PlanCard plan={plan} timeZone={timeZone} />
      {/* A last resort keeps its receipt after the first yes (CE-22): what does not hold stays in sight. */}
      {plan.lastResort !== undefined && <GuardReceipt plan={plan} />}
    </>
  );
}

/** How the family alert of a last resort went (#170), in the words the voice uses; a failure is urgent. */
function FamilyAlert({ sent, failed }: { sent: number; failed: number }) {
  const total = sent + failed;
  if (failed > 0) return <p role="alert">{t('plan.familyFailed', { failed: String(failed), total: String(total) })}</p>;
  const text = total === 0 ? t('plan.familyNone') : sent === 1 ? t('plan.familySentOne') : t('plan.familySentMany', { sent: String(sent) });
  return <p className="notice">{text}</p>;
}
