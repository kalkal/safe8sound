import type { ApplyPlanOutput } from '@cold-reserve/contracts';
import { useEffect, useRef, useState } from 'react';
import { GuardReceipt, RefusalReceipt } from '../GuardReceipt.js';
import { IceCubesCard } from '../IceCubesCard.js';
import { PlanCard } from '../PlanCard.js';
import { PreferencesCard } from '../PreferencesCard.js';
import { FloorPlanCard } from '../FloorPlanCard.js';
import { ManualControlCard } from '../ManualControlCard.js';
import { SafeRoomCard } from '../SafeRoomCard.js';
import { homeClock, isSimulated } from '../plan-model.js';
import { t } from '../text.js';
import { CardShell, DisplaySlot, DisplayToggle, type DisplayControl } from '../CardShell.js';
import { CardErrorBoundary } from './CardErrorBoundary.js';
import { Fit } from './Fit.js';
import { offersFullScreen, type CardState } from './card-kinds.js';
import { canAct as canActNow, type CardAction } from '../card-action.js';

/**
 * The height a host first gives a card frame, kept while the card waits for its result: a card that reported the
 * one-line "Loading…" height and then grew made the page jump under a finger or a click (#258, #246).
 */
export const CARD_WAITING_MIN_PX = 360;

export interface CardAppProps {
  state: CardState;
  /** IANA zone from hostContext.timeZone: on an Echo Show at home it is the home's clock. */
  timeZone: string;
  /** False when the host announces no serverTools: Apply and Save are hidden, and the card says so. */
  canAct: boolean;
  /** A card action is a tool call through the host (MCP Apps callServerTool); settles when the host answered. */
  onCallTool: (name: string, args: Record<string, unknown>) => Promise<void>;
  /** Where the action of this frame stands, as the host says (card-action); ready when it says nothing. */
  action?: CardAction;
  /** The outcome of the last action (e.g. "Preferences saved." or the error in words). */
  notice?: { ok: boolean; text: string };
  /** Full screen for the whole frame, when the host offers it (#200). */
  display?: DisplayControl;
  /** The height the host gives this frame (MCP Apps containerDimensions): the card fits itself in it. */
  maxHeight?: number | undefined;
}

/** The content of one ui:// frame. The host owns the conversation; the card only shows and asks. */
export function CardApp({ notice, display, maxHeight, action = { phase: 'ready' }, onCallTool, ...props }: CardAppProps) {
  const call = useOneCallAtATime(onCallTool, action);
  // Only dense views offer "Full screen" (idea 6); a frame already full screen always keeps its way back, whatever
  // it now shows (e.g. a refusal after Apply). A page too tall for its frame even at the readable scale offers it too
  // (owner, 12 Oct): never a thumbnail, and the whole page one tap away.
  const [cramped, setCramped] = useState(false);
  const toggle = display !== undefined && (display.fullscreen || offersFullScreen(props.state.kind) || cramped) ? <DisplayToggle display={display} /> : null;
  return (
    <CardErrorBoundary display={display}>
      <Fit maxHeight={maxHeight} onCramped={setCramped}>
      {/* "Full screen" sits in the first card's title row; "Loading…", an error and a crash are cards too, so a frame in full screen keeps its way back (#353, #356). */}
      <DisplaySlot.Provider value={toggle}>
      {notice !== undefined &&
        (notice.ok ? (
          <p className="notice" role="status">
            {notice.text}
          </p>
        ) : (
          <p role="alert">{notice.text}</p>
        ))}
      <CardContent {...props} action={action} call={call} />
      </DisplaySlot.Provider>
      </Fit>
    </CardErrorBoundary>
  );
}

/**
 * One tap, one call: a second tap before the host answered reaches nobody (a synchronous ref, so even two taps in the
 * same frame make one call), and nothing is sent while the host says the action has nothing to do. `pending` tells
 * "Not now" that an apply is on its way before the host's busy arrives.
 */
interface CardCall {
  send: (name: string, args: Record<string, unknown>) => void;
  pending: () => boolean;
}

function useOneCallAtATime(onCallTool: CardAppProps['onCallTool'], action: CardAction): CardCall {
  const calling = useRef(false);
  return {
    send: (name, args) => {
      if (calling.current || !canActNow(action)) return;
      calling.current = true;
      const settle = () => {
        calling.current = false;
      };
      onCallTool(name, args).then(settle, settle);
    },
    pending: () => calling.current,
  };
}

interface CardContentProps extends Omit<CardAppProps, 'notice' | 'display' | 'maxHeight' | 'onCallTool'> {
  action: CardAction;
  call: CardCall;
}

function CardContent({ state, timeZone, canAct, action, call }: CardContentProps) {
  switch (state.kind) {
    case 'waiting':
      // A card with its title row (#356): a frame left full screen while it waits keeps "Back" and Escape. The height the
      // host first gives the frame sits on the whole card, not on the paragraph, so the frame never grows (#258, #246).
      return (
        <div data-testid="card-waiting" style={{ minBlockSize: `${String(CARD_WAITING_MIN_PX)}px` }}>
          <CardShell title={t('card.waitingTitle')}>
            <p className="muted" role="status">
              {t('card.loading')}
            </p>
          </CardShell>
        </div>
      );
    case 'error':
      // Still a card with its title row (#353): in full screen "Back to the conversation" and Escape stay.
      return (
        <CardShell title={t('card.errorTitle')}>
          <p role="alert">{state.message}</p>
        </CardShell>
      );
    case 'plan':
      return <ProposedPlan key={state.data.id} plan={state.data} timeZone={timeZone} canAct={canAct} action={action} call={call} />;
    case 'refused':
      return (
        <>
          <p role="alert">{t('plan.refused', { message: state.data.message })}</p>
          <RefusalReceipt refusal={state.data} />
        </>
      );
    case 'applied':
      return (
        <AppliedPlan
          result={state.data}
          timeZone={timeZone}
          fromThisFrame={state.fromThisFrame === true}
          canConfirm={canAct}
          action={action}
          onConfirm={(args) => {
            call.send('apply_plan', args);
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
            busy={action.phase === 'busy'}
            {...(state.data.rooms !== undefined && { rooms: state.data.rooms })}
            {...(canAct && {
              onSave: (change: Record<string, unknown>) => {
                call.send('set_preferences', change);
              },
            })}
          />
          {!canAct && <p className="muted">{t('card.noActions')}</p>}
        </>
      );
  }
}

interface ProposedPlanProps {
  plan: Extract<CardState, { kind: 'plan' }>['data'];
  timeZone: string;
  canAct: boolean;
  action: CardAction;
  call: CardCall;
}

/**
 * A proposed plan. "Not now" (#348) stays inside this frame: no tool call, so nothing in the home changes and a last
 * resort is never applied by it. The card folds to one line that says so; the person can ask again by voice.
 */
function ProposedPlan({ plan, timeZone, canAct, action, call }: ProposedPlanProps) {
  const [dismissed, setDismissed] = useState(false);
  const lineRef = useRef<HTMLParagraphElement>(null);
  // The button the person tapped is gone: focus goes to what the card now says.
  useEffect(() => {
    if (dismissed) lineRef.current?.focus();
  }, [dismissed]);
  if (dismissed) {
    // Still the plan card, with its title row: in full screen "Back to the conversation" and Escape stay (review of #351).
    return (
      <CardShell title={t('plan.title')} origin={isSimulated(plan) ? 'simulated' : 'live'}>
        <p className="notice" role="status" tabIndex={-1} ref={lineRef} data-testid="plan-dismissed">
          {t('plan.dismissed')}
        </p>
      </CardShell>
    );
  }
  return (
    <>
      <PlanCard
        plan={plan}
        timeZone={timeZone}
        // The safety check is the plan's last page (pages instead of scrolling, owner 10 Oct).
        extraPages={[<GuardReceipt key="receipt" plan={plan} />]}
        action={action}
        // Shown again after its plan was applied (Previous, or applied by voice): no Apply or Not now, and no "Plan applied"
        // of its own: the answer above the card says it once (owner, 21 Oct).
        {...(action.phase === 'applied' && { outcome: null })}
        {...(canAct && {
          onApply: (planId: string) => {
            call.send('apply_plan', { planId });
          },
          onDismiss: () => {
            // Never "not applied" on a plan whose apply is on its way.
            if (!call.pending()) setDismissed(true);
          },
        })}
      />
      {!canAct && <p className="muted">{t('card.noActions')}</p>}
    </>
  );
}

interface AppliedPlanProps {
  result: ApplyPlanOutput;
  timeZone: string;
  /** The answer to this frame's own tap (not a voice turn's card). */
  fromThisFrame: boolean;
  /** The host can run card actions and this frame made the first step itself. */
  canConfirm: boolean;
  /** Where the second step stands, as the host says: on its way, or its confirmation expired. */
  action: CardAction;
  /** The second step of a last resort: apply_plan with the token the first step returned. */
  onConfirm: (args: { planId: string; lastResortToken: string }) => void;
}

function AppliedPlan({ result, timeZone, fromThisFrame, canConfirm, action, onConfirm }: AppliedPlanProps) {
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // The answer replaces the button the person tapped: focus goes to what it says, or to the card's title when it says
  // nothing more (a plain apply). A voice turn's card never takes the focus from the Ask box.
  useEffect(() => {
    if (!fromThisFrame) return;
    const title = cardRef.current?.querySelector<HTMLElement>('h2');
    // Focusable by script only, and only here: no other card's markup changes.
    title?.setAttribute('tabindex', '-1');
    (noticeRef.current ?? title)?.focus();
  }, [fromThisFrame]);
  const { plan, alreadyApplied, advisoryOnly, manualInstructions, confirmation, familyAlert } = result;
  // The first yes to a last resort applies nothing (#160): the card must not say "applied".
  // Advice is never "applied": nothing changes in the home, the person does it (plan §11.6).
  const confirmLabel = t('plan.confirmLastResort');
  // A plain apply says nothing here: "Done — plan applied" is said once, under the answer (owner, 21 Oct).
  let notice: string | undefined;
  // A first yes whose second yes the host says succeeded (the card shown again by Previous) is applied, not pending.
  const pending = confirmation !== undefined && action.phase !== 'applied' ? confirmation : undefined;
  if (pending === undefined) notice = advisoryOnly ? t('plan.appliedAsAdvice') : alreadyApplied ? t('plan.alreadyApplied') : undefined;
  else {
    const time = homeClock(pending.expiresAt, timeZone);
    notice = canConfirm ? t('plan.notYetAppliedTap', { button: confirmLabel, time }) : t('plan.notYetApplied', { time });
  }
  const off = !canActNow(action);
  // CE-22: the notice, the second step and the family alert inside the plan card itself, where Apply was: one card.
  const confirming = pending !== undefined && canConfirm;
  const outcome =
    notice === undefined && !confirming && familyAlert === undefined ? null : (
    <>
      {notice !== undefined && (
        <p className="notice" role="status" tabIndex={-1} ref={noticeRef}>
          {notice}
        </p>
      )}
      {/* The token stays in this frame's memory: it is sent back, never shown or logged. */}
      {confirming && (
        <>
          {action.phase === 'expired' && <p className="muted">{t('plan.expired')}</p>}
          <button
            type="button"
            className="button-primary"
            disabled={off}
            onClick={() => {
              if (!off) onConfirm({ planId: plan.id, lastResortToken: pending.token });
            }}
          >
            {confirmLabel}
          </button>
        </>
      )}
      {familyAlert !== undefined && <FamilyAlert sent={familyAlert.sent} failed={familyAlert.failed} />}
    </>
  );
  return (
    <div ref={cardRef}>
      {/* Every plan keeps its safety check once applied (owner feedback, 6 Oct; a last resort since CE-22): its last page. */}
      <PlanCard plan={plan} timeZone={timeZone} extraPages={[<GuardReceipt key="receipt" plan={plan} />]} action={action} outcome={outcome} />
      {/* The real home is read-only during the hackathon: the splits are set by hand (plan §11.6). */}
      {advisoryOnly && manualInstructions.length > 0 && (
        <ManualControlCard instructions={manualInstructions} reason="read_only" origin={isSimulated(plan) ? 'simulated' : 'live'} />
      )}
    </div>
  );
}

/** How the family alert of a last resort went (#170), in the words the voice uses; a failure is urgent. */
function FamilyAlert({ sent, failed }: { sent: number; failed: number }) {
  const total = sent + failed;
  if (failed > 0) return <p role="alert">{t('plan.familyFailed', { failed: String(failed), total: String(total) })}</p>;
  const text = total === 0 ? t('plan.familyNone') : sent === 1 ? t('plan.familySentOne') : t('plan.familySentMany', { sent: String(sent) });
  return <p className="notice">{text}</p>;
}
