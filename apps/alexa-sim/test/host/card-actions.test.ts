import { PlanIdSchema, toolError } from '@cold-reserve/contracts';
import { hotDayPlan, lastResortPlan } from '@cold-reserve/ui-cards';
import { describe, expect, it } from 'vitest';
import { toolErrorResult } from '../../src/agent/agent.js';
import type { ToolCard } from '../../src/agent/wire.js';
import { NO_ACTIONS, actionOf, answeredOnCard, cardActionFor, nextFrameAction, recordAnswer, recordCall } from '../../src/host/card-actions.js';
import { SCRIPT_FIXTURES } from '../../src/agent/script-fixtures.js';

// The host keeps where each card's action stands, per turn, above the frames: a card shown again (Previous) gets it
// back in one message, so it never offers Apply on a plan already applied. Pure code; CardFrame and main.tsx wire it.

const planCard: ToolCard = { tool: 'plan_comfort', result: hotDayPlan() };
const lastResortCard: ToolCard = { tool: 'plan_comfort', result: lastResortPlan() };
const appliedResult = { content: [], structuredContent: { plan: { ...hotDayPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] } };
const firstYes = {
  content: [],
  structuredContent: { plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token: `lr_${'T'.repeat(32)}`, expiresAt: '2026-07-15T14:08:00+02:00' } },
};
// hotDayPlan: created 14:00, valid until 14:10 (Rome).
const BEFORE = '2026-07-15T14:05:00+02:00';
const AFTER = '2026-07-15T14:10:00+02:00';

describe('nextFrameAction: what a card call did to its turn', () => {
  it('a call on its way is busy; its answer ends it', () => {
    const busy = nextFrameAction(undefined, { type: 'started' });
    expect(busy).toEqual({ busy: true });
    expect(nextFrameAction(busy, { type: 'answered', result: toolErrorResult(toolError('unexpected_error', 'Something went wrong.')) })).toEqual({ busy: false });
  });

  it('an applied plan is applied, at the time the host gives (when it knows one)', () => {
    expect(nextFrameAction({ busy: true }, { type: 'answered', result: appliedResult, at: BEFORE })).toEqual({ busy: false, applied: { at: BEFORE } });
    expect(nextFrameAction({ busy: true }, { type: 'answered', result: appliedResult })).toEqual({ busy: false, applied: {} });
  });

  it('the first yes to a last resort is not applied: its confirmation brings its own deadline', () => {
    expect(nextFrameAction({ busy: true }, { type: 'answered', result: firstYes })).toEqual({ busy: false, deadline: '2026-07-15T14:08:00+02:00' });
  });

  it('the server saying the plan expired makes it expired for good', () => {
    const expired = toolErrorResult(toolError('plan_expired', 'This plan has expired; ask for a new one.'));
    expect(nextFrameAction({ busy: true }, { type: 'answered', result: expired })).toEqual({ busy: false, expired: true });
  });
});

describe('cardActionFor: the one message a frame sends its card', () => {
  it('ready with nothing recorded; busy while a call is on its way', () => {
    expect(cardActionFor(planCard, undefined, BEFORE)).toEqual({ phase: 'ready' });
    expect(cardActionFor(planCard, { busy: true }, BEFORE)).toEqual({ phase: 'busy' });
  });

  it('applied wins over everything, with its time', () => {
    expect(cardActionFor(planCard, { busy: false, applied: { at: BEFORE } }, AFTER)).toEqual({ phase: 'applied', at: BEFORE });
    expect(cardActionFor(planCard, { busy: false, applied: {} }, undefined)).toEqual({ phase: 'applied' });
  });

  it('a plan is expired from its expiresAt on the clock the plans are made on, or when the server said so', () => {
    expect(cardActionFor(planCard, undefined, AFTER)).toEqual({ phase: 'expired' });
    expect(cardActionFor(planCard, { busy: false, expired: true }, undefined)).toEqual({ phase: 'expired' });
    // Without that clock (the scripted demo, whose plans are dated by its script), only the server can say it.
    expect(cardActionFor(planCard, undefined, undefined)).toEqual({ phase: 'ready' });
  });

  it('the second yes expires with its confirmation, from a tap or from a voice turn', () => {
    expect(cardActionFor(lastResortCard, { busy: false, deadline: '2026-07-15T14:08:00+02:00' }, BEFORE)).toEqual({ phase: 'ready' });
    expect(cardActionFor(lastResortCard, { busy: false, deadline: '2026-07-15T14:08:00+02:00' }, '2026-07-15T14:08:00+02:00')).toEqual({ phase: 'expired' });
    const spoken = SCRIPT_FIXTURES['last-resort-pending']();
    expect(cardActionFor(spoken, undefined, '2026-07-15T21:20:00+02:00')).toEqual({ phase: 'expired' });
    expect(cardActionFor(spoken, undefined, '2026-07-15T21:19:00+02:00')).toEqual({ phase: 'ready' });
  });
});

describe('recordCall: one record per card of a turn, so a sibling card is never touched', () => {
  const preferencesCard = SCRIPT_FIXTURES.preferences();

  it('a plan applied in a turn leaves the preferences card of the same turn ready', () => {
    let actions = recordCall(NO_ACTIONS, 'turn-1', planCard, { type: 'started' });
    expect(cardActionFor(preferencesCard, actionOf(actions, 'turn-1', preferencesCard), undefined)).toEqual({ phase: 'ready' });
    actions = recordCall(actions, 'turn-1', planCard, { type: 'answered', result: appliedResult });
    expect(cardActionFor(planCard, actionOf(actions, 'turn-1', planCard), undefined)).toEqual({ phase: 'applied' });
    expect(cardActionFor(preferencesCard, actionOf(actions, 'turn-1', preferencesCard), undefined)).toEqual({ phase: 'ready' });
    // Another plan in the same turn is another card.
    const other: ToolCard = { tool: 'plan_comfort', result: { ...hotDayPlan(), id: PlanIdSchema.parse('plan_OtherPlan01') } };
    expect(cardActionFor(other, actionOf(actions, 'turn-1', other), undefined)).toEqual({ phase: 'ready' });
  });
});

describe('recordAnswer: a plan applied by voice is applied on the card that proposed it', () => {
  it('"OK, apply it": the apply_plan result of a later turn marks the plan card of the turn that proposed it', () => {
    let actions = recordAnswer(NO_ACTIONS, 'turn-1', [planCard]);
    actions = recordAnswer(actions, 'turn-2', [SCRIPT_FIXTURES['hot-day-applied']()], BEFORE);
    expect(cardActionFor(planCard, actionOf(actions, 'turn-1', planCard), undefined)).toEqual({ phase: 'applied', at: BEFORE });
    // Another plan stays as it was.
    const other: ToolCard = { tool: 'plan_comfort', result: { ...hotDayPlan(), id: PlanIdSchema.parse('plan_OtherPlan01') } };
    expect(cardActionFor(other, actionOf(actions, 'turn-1', other), undefined)).toEqual({ phase: 'ready' });
  });

  it('a first yes to a last resort applies nothing: its plan card stays ready', () => {
    let actions = recordAnswer(NO_ACTIONS, 'turn-1', [lastResortCard]);
    actions = recordAnswer(actions, 'turn-2', [SCRIPT_FIXTURES['last-resort-pending']()], BEFORE);
    expect(cardActionFor(lastResortCard, actionOf(actions, 'turn-1', lastResortCard), BEFORE)).toEqual({ phase: 'ready' });
  });

  it('a later proposal is a new plan even with the same id (the scripted fixtures share one): applied stays where it was', () => {
    // Hot day → applied (by tap, then by voice) → the storm starts: its plan card keeps Apply and Not now, no done line.
    const storm = SCRIPT_FIXTURES['storm-plan']();
    for (const apply of ['tap', 'voice'] as const) {
      let actions = recordAnswer(NO_ACTIONS, 'turn-1', [planCard]);
      actions =
        apply === 'tap'
          ? recordCall(actions, 'turn-1', planCard, { type: 'answered', result: appliedResult })
          : recordAnswer(actions, 'turn-2', [SCRIPT_FIXTURES['hot-day-applied']()]);
      actions = recordAnswer(actions, 'turn-3', [storm]);
      expect(cardActionFor(storm, actionOf(actions, 'turn-3', storm), undefined), apply).toEqual({ phase: 'ready' });
      expect(answeredOnCard(actions, 'turn-3', [storm]), apply).toBe(false);
      // The hot-day card, shown again, is still applied.
      expect(cardActionFor(planCard, actionOf(actions, 'turn-1', planCard), undefined), apply).toEqual({ phase: 'applied' });
      expect(answeredOnCard(actions, 'turn-1', [planCard]), apply).toBe(true);
    }
  });
});

describe('answeredOnCard: an answer that asked, whose plan is now applied (the steps, "Done — plan applied")', () => {
  it('a proposed plan, or a first yes, once its plan is applied, by tap or by voice', () => {
    const proposed = recordAnswer(NO_ACTIONS, 'turn-1', [planCard]);
    expect(answeredOnCard(proposed, 'turn-1', [planCard])).toBe(false);
    expect(answeredOnCard(recordCall(proposed, 'turn-1', planCard, { type: 'answered', result: appliedResult }), 'turn-1', [planCard])).toBe(true);
    expect(answeredOnCard(recordAnswer(proposed, 'turn-2', [SCRIPT_FIXTURES['hot-day-applied']()]), 'turn-1', [planCard])).toBe(true);
    // A spoken first yes, then its tap: the confirmation turn and the turn that proposed the last resort are both answered.
    const pending = SCRIPT_FIXTURES['last-resort-pending']();
    const second = { content: [], structuredContent: { plan: { ...lastResortPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] } };
    let actions = recordAnswer(NO_ACTIONS, 'turn-1', [lastResortCard]);
    actions = recordAnswer(actions, 'turn-2', [pending]);
    actions = recordCall(actions, 'turn-2', pending, { type: 'answered', result: second });
    expect(answeredOnCard(actions, 'turn-2', [pending])).toBe(true);
    expect(answeredOnCard(actions, 'turn-1', [lastResortCard])).toBe(true);
  });

  it('never an answer that already said it was applied, nor one with no plan', () => {
    let actions = recordAnswer(NO_ACTIONS, 'turn-1', [planCard]);
    actions = recordAnswer(actions, 'turn-2', [SCRIPT_FIXTURES['hot-day-applied']()]);
    expect(answeredOnCard(actions, 'turn-2', [SCRIPT_FIXTURES['hot-day-applied']()])).toBe(false);
    expect(answeredOnCard(actions, 'turn-1', [SCRIPT_FIXTURES.preferences()])).toBe(false);
    expect(answeredOnCard(actions, 'turn-1', undefined)).toBe(false);
  });
});
