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

  it('catches a refusal of a number the person never asked for (the forecast taken as a setpoint, 21 Oct)', () => {
    const asked = "It's going to be 36 degrees tomorrow, keep Leo cool.";
    expect(answerRuleViolations("The safety check refused 36 degrees; this plan holds instead: Leo's room under 26.5 degrees until 08:00.", asked)).toEqual(['refusal-names-unasked-number']);
    // what the person did ask for is named by the refusal as it should be
    expect(answerRuleViolations('The safety check refused 21 degrees; this plan holds instead.', 'Set every room to 21 degrees.')).toEqual([]);
    expect(answerRuleViolations('The safety check refused 21.5 degrees.', 'Cool Leo’s room to 21.5 degrees now.')).toEqual([]);
    // other ways to ask for a temperature
    expect(answerRuleViolations('The safety check refused 21 degrees; this plan holds instead.', 'Lower every room to 21')).toEqual([]);
    expect(answerRuleViolations('The safety check refused 21 degrees; this plan holds instead.', 'Can I have 21 degrees in every room?')).toEqual([]);
    expect(answerRuleViolations('The safety check refused 20 degrees.', 'Make the living room 20 degrees now.')).toEqual([]);
    // the °C equivalent of a °F ask
    expect(answerRuleViolations('The safety check refused 22.2 °C (72 °F); this plan holds instead.', 'Set the study to 72 degrees Fahrenheit')).toEqual([]);
    expect(answerRuleViolations('The safety check refused 22.2 °C.', 'Set the study to 80 degrees Fahrenheit')).toEqual(['refusal-names-unasked-number']);
    // a number that is a result or a limit, not the refused ask
    expect(answerRuleViolations("The safety check refused that plan: Leo's room would reach 31 degrees.", 'Set every room to 21 degrees.')).toEqual([]);
    expect(answerRuleViolations('The safety check refused that; the nearest allowed is 24 °C.', 'Set every room to 21 degrees.')).toEqual([]);
    // a refusal that names no number, or an answer with no refusal, is fine; without the question the rule is not applied
    expect(answerRuleViolations("The safety check refused that. This plan holds: Leo's room under 26.5 degrees.", asked)).toEqual([]);
    expect(answerRuleViolations('Tomorrow reaches 36 degrees, so I can keep Leo’s room under 27 degrees.', asked)).toEqual([]);
    expect(answerRuleViolations('The safety check refused 36 degrees.')).toEqual([]);
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
