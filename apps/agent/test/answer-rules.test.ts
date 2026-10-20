import { describe, expect, it } from 'vitest';
import { answerRuleViolations, asksToConfirmAnAppliedPlan } from '../src/evals/answer-rules.js';

// The rules on the words the assistant says (found on the real site, 20 Oct): the exact sentences seen there are caught,
// and ordinary good answers are not.

describe('answerRuleViolations', () => {
  it('catches a room named after its person, in either spelling of the apostrophe', () => {
    expect(answerRuleViolations("I can keep Grandpa's room at 25 °C.")).toEqual(['room-named-after-person']);
    expect(answerRuleViolations('Grandma’s bedroom is at 26 °C.')).toEqual(['room-named-after-person']);
  });

  it('lets the name the home gives pass, and a person named without a room', () => {
    expect(answerRuleViolations("Leo's room is at 25.5 °C. Grandpa is comfortable.")).toEqual([]);
  });

  it('catches a time in 12 hours, as the real model said it', () => {
    expect(answerRuleViolations('Solar surplus from 12:10 PM to 7:50 PM will be used.')).toEqual(['twelve-hour-time']);
    expect(answerRuleViolations('Comfortable until 12:00 AM.')).toEqual(['twelve-hour-time']);
    expect(answerRuleViolations('It runs until 7 pm.')).toEqual(['twelve-hour-time']);
  });

  it('lets 24-hour times and ordinary words pass', () => {
    expect(answerRuleViolations('Comfortable until 00:00; the sun covers it from 12:15 to 19:25. I am sure, 3 amps are fine.')).toEqual([]);
  });

  it('catches an internal id read aloud', () => {
    expect(answerRuleViolations('Your safe room is set to bedroom-1.')).toEqual(['internal-id']);
    expect(answerRuleViolations('Plan plan_Hq2mX9vK3 is waiting for your yes.')).toEqual(['internal-id']);
  });

  it('reports every broken rule, in order', () => {
    expect(answerRuleViolations("Grandpa's room until 7:00 PM.")).toEqual(['room-named-after-person', 'twelve-hour-time']);
  });
});

describe('asksToConfirmAnAppliedPlan', () => {
  const asks = 'The plan will keep Leo’s room at 25 °C. Do you want me to start this plan?';

  it('is true when a card says the plan is applied and the answer asks to confirm it (the real answer of 20 Oct)', () => {
    expect(asksToConfirmAnAppliedPlan(asks, 'Plan applied.')).toBe(true);
    expect(asksToConfirmAnAppliedPlan('Please confirm by saying "yes" and I will start it.', 'The plan was already applied.')).toBe(true);
  });

  it('is false for a correct follow-up about something else, even with the card saying applied', () => {
    expect(asksToConfirmAnAppliedPlan('The plan is in place. Should I start storm prepare too?', 'Plan applied.')).toBe(false);
    expect(asksToConfirmAnAppliedPlan('Done. Shall I start the storm preparation as well?', 'The plan was already applied.')).toBe(false);
  });

  it('is true for the sentences that ask for the plan itself', () => {
    expect(asksToConfirmAnAppliedPlan('Shall I start this plan?', 'Plan applied.')).toBe(true);
    expect(asksToConfirmAnAppliedPlan('Should I go ahead with the plan?', 'Plan applied.')).toBe(true);
  });

  it('is false when the card does not say applied, or the answer does not ask', () => {
    expect(asksToConfirmAnAppliedPlan(asks, 'Plan valid until 14:10. Apply plan')).toBe(false);
    expect(asksToConfirmAnAppliedPlan('The plan is already in place.', 'Plan applied.')).toBe(false);
  });
});
