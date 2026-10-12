// "Back" always there and the path of the steps (idea 5, after Alexa's backstack): Conversation → Home → Plan →
// Confirm, the current one marked in the header band; Back returns to the screen before this one. Pure, so the rules
// are tested without a page.

import type { CardSlot } from '../agent/wire.js';

export const STEPS = ['conversation', 'home', 'plan', 'confirm'] as const;
export type Step = (typeof STEPS)[number];

/** A card's view for the steps: its tool and, for apply_plan, its result. */
export type StepCard = { tool: CardSlot['tool']; result?: unknown };

export interface StepScreen {
  /** The home panel is open in the content band. */
  homeOpen: boolean;
  /** The cards of the answer on screen; undefined on the first screen or while a turn runs. */
  cards: readonly StepCard[] | undefined;
  /** The plan on screen was applied from its card. */
  applied: boolean;
}

/**
 * An apply_plan result that really applied the plan (review of #350): the first step of a last resort comes back
 * "proposed", waiting for the second yes, and is not a confirmation yet.
 */
export function isAppliedPlan(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || !('plan' in result)) return false;
  const { plan } = result;
  return typeof plan === 'object' && plan !== null && 'status' in plan && plan.status === 'applied';
}

/** Where the screen is: an applied plan is confirmed, a plan is the plan, the home is the home, the rest is talk. */
export function stepOf({ homeOpen, cards = [], applied }: StepScreen): Step {
  if (homeOpen) return 'home';
  const has = (tool: CardSlot['tool']) => cards.some((card) => card.tool === tool);
  const plan = has('plan_comfort') || has('apply_plan');
  if (cards.some((card) => card.tool === 'apply_plan' && isAppliedPlan(card.result)) || (applied && plan)) return 'confirm';
  if (plan) return 'plan';
  if (has('get_home_status')) return 'home';
  return 'conversation';
}

export type BackAction = 'close_home' | 'previous_answer' | 'start';

/**
 * What Back does: closes the home (back to what was under it), shows the answer before, or from the first answer the
 * first screen. Nothing while a turn runs or failed (Cancel / Try again act there), nor on the first screen. While
 * listening it works, so a spoken "Go back" is a command, never a turn (review of #350, as pagerSayable in #347).
 */
export function backAction({ thinking, failed, homeOpen, answerIndex }: { thinking: boolean; failed: boolean; homeOpen: boolean; answerIndex: number }): BackAction | undefined {
  if (thinking || failed) return undefined;
  if (homeOpen) return 'close_home';
  if (answerIndex > 0) return 'previous_answer';
  if (answerIndex === 0) return 'start';
  return undefined;
}
