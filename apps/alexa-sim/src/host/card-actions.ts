import { ApplyPlanOutputSchema, ErrorEnvelopeSchema, epochMs } from '@cold-reserve/contracts';
import type { CardAction } from '@cold-reserve/ui-cards';
import type { ToolCallResult } from '../agent/agent.js';
import type { CardSlot, ToolCard } from '../agent/wire.js';
import { isAppliedPlan } from '../ui/steps.js';

// Where each card's action stands, kept by the host per card of a turn, above the frames (a card shown again by Previous is a
// new frame): on its way, applied, expired. CardFrame sends it to its card in one message (card-action); the card
// keeps no such state of its own. The server's idempotency (alreadyApplied, plan_expired) stays the real barrier.

export interface FrameAction {
  /** A call of the turn's card is on its way. */
  busy: boolean;
  /** Its plan was applied from the card; `at` on the clock the plans are made on, when the host knows it. */
  applied?: { at?: string };
  /** The server said the plan expired. */
  expired?: boolean;
  /** The first yes to a last resort: its second yes is possible until then. */
  deadline?: string;
}

export type FrameEvent = { type: 'started' } | { type: 'answered'; result: ToolCallResult; at?: string | undefined };

export function nextFrameAction(previous: FrameAction | undefined, event: FrameEvent): FrameAction {
  const base: FrameAction = { ...previous, busy: event.type === 'started' };
  if (event.type === 'started') return base;
  const { result, at } = event;
  if (result.isError === true) {
    const envelope = ErrorEnvelopeSchema.safeParse(result.structuredContent);
    return envelope.success && envelope.data.code === 'plan_expired' ? { ...base, expired: true } : base;
  }
  if (isAppliedPlan(result.structuredContent)) return { ...base, applied: at === undefined ? {} : { at } };
  const output = ApplyPlanOutputSchema.safeParse(result.structuredContent);
  const confirmation = output.success ? output.data.confirmation : undefined;
  return confirmation === undefined ? base : { ...base, deadline: confirmation.expiresAt };
}

/** Until when the card's plan (or its last-resort confirmation) can be applied. */
function deadlineOf(card: ToolCard, action: FrameAction | undefined): string | undefined {
  if (action?.deadline !== undefined) return action.deadline;
  if (card.tool === 'plan_comfort' && 'id' in card.result) return card.result.expiresAt;
  if (card.tool === 'apply_plan') return card.result.confirmation?.expiresAt;
  return undefined;
}

/**
 * The one message a frame sends its card. `now`: the clock the plans are made on (the sandbox's simulated clock),
 * when the page knows it; without it only the server can say a plan expired.
 */
export function cardActionFor(card: ToolCard, action: FrameAction | undefined, now: string | undefined): CardAction {
  if (action?.applied !== undefined) return { phase: 'applied', ...(action.applied.at === undefined ? {} : { at: action.applied.at }) };
  if (action?.busy === true) return { phase: 'busy' };
  const deadline = deadlineOf(card, action);
  const past = now !== undefined && deadline !== undefined && epochMs(now) >= epochMs(deadline);
  return action?.expired === true || past ? { phase: 'expired' } : { phase: 'ready' };
}

/**
 * Each card of a turn has its own record (busy, expired, its deadline): a call never touches a sibling card. Applied
 * belongs to a proposal: the turn that proposed the plan and the plan's id. A plan id alone is not enough: a later
 * proposal is a new plan even with the same id (the scripted fixtures share one), so it never inherits "applied".
 */
export interface CardActions {
  readonly cards: ReadonlyMap<string, FrameAction>;
  /** The turn of the latest proposal (plan_comfort) of each plan id: what a yes by voice applies. */
  readonly proposals: ReadonlyMap<string, string>;
  /** The proposals applied, by turn and plan id. */
  readonly applied: ReadonlyMap<string, { at?: string }>;
}
export const NO_ACTIONS: CardActions = { cards: new Map(), proposals: new Map(), applied: new Map() };

/** The plan a card shows (a proposal, or an apply_plan result); none for any other card. */
function planIdOf(card: CardSlot): string | undefined {
  if (card.tool === 'plan_comfort' && 'id' in card.result) return card.result.id;
  if (card.tool === 'apply_plan') return card.result.plan.id;
  return undefined;
}

const isProposal = (card: CardSlot): boolean => card.tool === 'plan_comfort' && 'id' in card.result;
/** A card that asks for a yes: a proposal, or a first yes to a last resort waiting for the second. */
const asks = (card: CardSlot): boolean => isProposal(card) || (card.tool === 'apply_plan' && card.result.confirmation !== undefined);

/** A card is its turn, its tool and, for a plan, the plan's id. */
const cardKey = (turnId: string, card: ToolCard): string => JSON.stringify([turnId, card.tool, planIdOf(card) ?? '']);
const appliedKey = (turnId: string, planId: string): string => JSON.stringify([turnId, planId]);

function withApplied(applied: CardActions['applied'], turns: readonly (string | undefined)[], planId: string, at: string | undefined): CardActions['applied'] {
  const next = new Map(applied);
  for (const turnId of turns) if (turnId !== undefined) next.set(appliedKey(turnId, planId), at === undefined ? {} : { at });
  return next;
}

export function actionOf(actions: CardActions | undefined, turnId: string, card: ToolCard): FrameAction | undefined {
  const own = actions?.cards.get(cardKey(turnId, card));
  const planId = planIdOf(card);
  const applied = planId === undefined ? undefined : actions?.applied.get(appliedKey(turnId, planId));
  return applied === undefined ? own : { ...own, busy: false, applied };
}

/**
 * What a card call did, kept for that card of that turn. An applied plan is applied on this card's turn; from a
 * confirmation card (a spoken first yes), also on the card that proposed it.
 */
export function recordCall(actions: CardActions, turnId: string, card: ToolCard, event: FrameEvent): CardActions {
  const key = cardKey(turnId, card);
  const cards = new Map(actions.cards).set(key, nextFrameAction(actions.cards.get(key), event));
  const output = event.type === 'answered' && isAppliedPlan(event.result.structuredContent) ? ApplyPlanOutputSchema.safeParse(event.result.structuredContent) : undefined;
  if (output?.success !== true || event.type !== 'answered') return { ...actions, cards };
  const planId = output.data.plan.id;
  const turns = isProposal(card) ? [turnId] : [turnId, actions.proposals.get(planId)];
  return { ...actions, cards, applied: withApplied(actions.applied, turns, planId, event.at) };
}

/**
 * A turn's answer: a proposal becomes the one a yes by voice applies; an apply_plan result that applied a plan
 * ("OK, apply it") marks the latest proposal of that plan applied.
 */
export function recordAnswer(actions: CardActions, turnId: string, cards: readonly CardSlot[] | undefined, at?: string): CardActions {
  let { proposals, applied } = actions;
  for (const card of cards ?? []) {
    const planId = planIdOf(card);
    if (planId === undefined) continue;
    if (isProposal(card)) proposals = new Map(proposals).set(planId, turnId);
    else if (card.tool === 'apply_plan' && isAppliedPlan(card.result)) applied = withApplied(applied, [proposals.get(planId)], planId, at);
  }
  return proposals === actions.proposals && applied === actions.applied ? actions : { ...actions, proposals, applied };
}

/**
 * An answer that asked ("Do you want me to start this plan?", a first yes waiting for the second) whose plan is now
 * applied: the steps put it at "Confirm" and its words say "Done — plan applied". An answer that already said it was
 * applied never repeats it.
 */
export function answeredOnCard(actions: CardActions, turnId: string, cards: readonly CardSlot[] | undefined): boolean {
  return (cards ?? []).some((card) => {
    const planId = planIdOf(card);
    return asks(card) && planId !== undefined && actions.applied.has(appliedKey(turnId, planId));
  });
}
