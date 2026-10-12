import { describe, expect, it } from 'vitest';
import { STEPS, backAction, isAppliedPlan, stepOf, type StepCard } from '../../src/ui/steps.js';

// "Back" always there and the path of the steps (idea 5): Conversation → Home → Plan → Confirm, the current one
// marked; Back returns to the screen before this one.

const plan: StepCard = { tool: 'plan_comfort' };
const home: StepCard = { tool: 'get_home_status' };
const applied: StepCard = { tool: 'apply_plan', result: { plan: { status: 'applied' } } };
// The first step of a last resort (review of #350): nothing applied yet, the second yes is still to come.
const awaitingYes: StepCard = { tool: 'apply_plan', result: { plan: { status: 'proposed' }, confirmation: { token: 't' } } };

describe('stepOf', () => {
  it('the four steps, in order', () => {
    expect(STEPS).toEqual(['conversation', 'home', 'plan', 'confirm']);
  });

  it('nothing shown, or an answer without home or plan: the conversation', () => {
    expect(stepOf({ homeOpen: false, cards: undefined, applied: false })).toBe('conversation');
    expect(stepOf({ homeOpen: false, cards: [{ tool: 'invalid' }], applied: false })).toBe('conversation');
  });

  it('the home open, or an answer showing the home: the home', () => {
    expect(stepOf({ homeOpen: true, cards: [plan], applied: true })).toBe('home');
    expect(stepOf({ homeOpen: false, cards: [home], applied: false })).toBe('home');
  });

  it('an answer with a plan: the plan; once applied (by the card or by the answer): confirm', () => {
    expect(stepOf({ homeOpen: false, cards: [home, plan], applied: false })).toBe('plan');
    expect(stepOf({ homeOpen: false, cards: [plan], applied: true })).toBe('confirm');
    expect(stepOf({ homeOpen: false, cards: [applied], applied: false })).toBe('confirm');
  });

  it('a last resort waiting for the second yes is still the plan, not confirm', () => {
    expect(stepOf({ homeOpen: false, cards: [awaitingYes], applied: false })).toBe('plan');
  });
});

describe('isAppliedPlan', () => {
  it('only a result whose plan is applied', () => {
    expect(isAppliedPlan(applied.result)).toBe(true);
    expect(isAppliedPlan(awaitingYes.result)).toBe(false);
    expect(isAppliedPlan(undefined)).toBe(false);
    expect(isAppliedPlan({ plan: null })).toBe(false);
  });
});

describe('backAction', () => {
  const screen = { thinking: false, failed: false };

  it('nothing while a turn runs or failed (Cancel / Try again act there)', () => {
    expect(backAction({ ...screen, thinking: true, homeOpen: true, answerIndex: 2 })).toBeUndefined();
    expect(backAction({ ...screen, failed: true, homeOpen: false, answerIndex: 2 })).toBeUndefined();
  });

  it('the home open: it closes, back to what was under it', () => {
    expect(backAction({ ...screen, homeOpen: true, answerIndex: -1 })).toBe('close_home');
    expect(backAction({ ...screen, homeOpen: true, answerIndex: 1 })).toBe('close_home');
  });

  it('an answer: the one before it, and from the first answer the first screen', () => {
    expect(backAction({ ...screen, homeOpen: false, answerIndex: 2 })).toBe('previous_answer');
    expect(backAction({ ...screen, homeOpen: false, answerIndex: 0 })).toBe('start');
  });

  it('the first screen: nowhere to go back to', () => {
    expect(backAction({ ...screen, homeOpen: false, answerIndex: -1 })).toBeUndefined();
  });
});
