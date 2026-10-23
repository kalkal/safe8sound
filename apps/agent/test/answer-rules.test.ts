import { stormNotForecastMessage } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { answerRuleViolations, asksToConfirmAnAppliedPlan, notOneShortQuestion, refusalNotSaidFirst } from '../src/evals/answer-rules.js';

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

  describe('a plan the guard refused (21 Oct: the voice said "9 hours" over a card saying "0 of 6" and never said the refusal)', () => {
    const refused = ['The safety check refused the proposed plan: The plan keeps the safe room at or below 24 °C for 0 of the 6 night hours it can reach. This plan holds instead. It is ready to apply. Proposed plan: comfort level until 08:00.'];
    const asked = "It's going to be 36 degrees tomorrow, keep Leo cool.";

    it('the first sentence names the refusal', () => {
      expect(answerRuleViolations('The safety check refused that; this plan holds instead: Leo’s room under 26.5 degrees until 08:00. Shall I start it?', asked, refused)).toEqual([]);
      expect(answerRuleViolations('I can’t keep it that cool, so I made a plan that holds. Shall I start it?', asked, refused)).toEqual(['refusal-not-said-first']);
      // the sentence of the real failure: the plan said, the refusal never
      expect(answerRuleViolations('I can keep Leo’s room under 26.5 degrees and give the safe room 9 hours at or below 24 degrees at night. Shall I start it?', asked, refused)).toEqual(['refusal-not-said-first']);
      // a point between two digits does not end the first sentence ("21.5")
      expect(answerRuleViolations('I can’t hold 21.5 degrees: the safety check refused it. This plan holds instead. Shall I start it?', asked, refused)).toEqual([]);
      // said, but not first
      expect(answerRuleViolations('Leo’s room stays under 26.5 degrees. The safety check refused your first idea. Shall I start it?', asked, refused)).toEqual(['refusal-not-said-first']);
    });

    it('is not applied without a refusal in the tool results', () => {
      expect(answerRuleViolations('Leo’s room stays under 26.5 degrees. Shall I start it?', asked, ['Proposed plan: comfort level until 08:00.'])).toEqual([]);
    });
  });

  describe('a refusal the person never asked for is never said (owner, 22 Oct)', () => {
    // The model made the proposal up: the server sends only the plan that holds, without a refusal sentence.
    const plain = ['Proposed plan: comfort level until 08:00 (nothing changes until apply_plan), built on simulated data.'];
    const asked = "It's going to be 36 degrees tomorrow, keep Leo cool.";

    it('an answer that says "refused" over a plan without a refusal breaks the rule', () => {
      expect(answerRuleViolations('The safety check refused my first idea, but this plan keeps Leo cool until 08:00. Shall I start it?', asked, plain)).toEqual(['refusal-said-unasked']);
      expect(answerRuleViolations("I can keep Leo's room under 26.5 degrees until 08:00. Shall I start it?", asked, plain)).toEqual([]);
    });

    it('is not applied when the tool results carry the refusal (the person asked for it) or no plan at all', () => {
      const refused = ['The safety check refused the proposed plan: Peak load 8.0 kW is above the limit. This plan holds instead. It is ready to apply. Proposed plan: comfort level until 08:00.'];
      expect(answerRuleViolations('The safety check refused that: it would overload the inverter. This plan holds instead. Shall I start it?', 'Set every room to 21 degrees.', refused)).toEqual([]);
      expect(answerRuleViolations('The safety check refused every plan.', asked, [])).toEqual([]);
    });
  });

  describe('a storm-mode request with no storm in the forecast (21 Oct)', () => {
    const noStorm = [`Error: ${stormNotForecastMessage()}`, `Error: ${stormNotForecastMessage(true)}`];
    const said = 'The power went out.';

    it('the answer says nothing started and asks whether to get the home ready, and never claims it did', () => {
      expect(answerRuleViolations('The forecast I read shows no storm tonight. Shall I get the home ready anyway?', said, noStorm)).toEqual([]);
      expect(answerRuleViolations('No storm was started and no one was told about one. Shall I get the home ready anyway?', said, noStorm)).toEqual([]);
      expect(answerRuleViolations('The grid reads on at home, so nothing was started and no one was told. Do you want me to get the home ready anyway?', said, noStorm)).toEqual([]);
      // the sentence of the real failure: the home was prepared and the family told
      expect(answerRuleViolations('The grid is still on. I told your daughter a storm is expected and prepared the home.', said, noStorm)).toEqual(['ignores-storm-refusal']);
      // honest words, but no question to the person
      expect(answerRuleViolations('Nothing was started and no one was told.', said, noStorm)).toEqual(['ignores-storm-refusal']);
      // a plain answer that says neither
      expect(answerRuleViolations('Let me know if you need anything else.', said, noStorm)).toEqual(['ignores-storm-refusal']);
      // honest and asking, then claimed anyway
      expect(answerRuleViolations('Nothing was started, but I have notified the family. Shall I get the home ready?', said, noStorm)).toEqual(['ignores-storm-refusal']);
    });

    it('is not applied without that tool result in the tool results', () => {
      expect(answerRuleViolations('Storm mode is ready and the family was told.', 'A storm is coming tonight.', ['Storm prepare: 9 kWh reserved.'])).toEqual([]);
      expect(answerRuleViolations('Anything.', said)).toEqual([]);
    });
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

describe('notOneShortQuestion', () => {
  it('catches the real answer to "Make it better." (21 Oct): a list of three questions and an instruction', () => {
    const real =
      'I’m happy to help improve your home comfort. Would you like me to: - Adjust the temperature in any room? - Start or stop a comfort plan? - Check the battery or storm reserve? Just tell me what you’d like to change.';
    expect(notOneShortQuestion(real)).toBe(true);
  });

  it('passes one short question, with or without a short lead-in', () => {
    expect(notOneShortQuestion('What would you like me to change?')).toBe(false);
    expect(notOneShortQuestion('Sure. Which room should feel better?')).toBe(false);
  });

  it('passes the honest answer to "Yes, confirm it." with nothing to confirm (about 24 words), and a question inside closing quotes', () => {
    expect(notOneShortQuestion("There's no plan waiting for your yes right now, so I have nothing to confirm. What would you like me to do for the home?")).toBe(false);
    expect(notOneShortQuestion('You could say “Which room should I cool?”')).toBe(false);
    expect(notOneShortQuestion('Which room should I cool?) ')).toBe(false);
  });

  it('catches two questions, a question that is not the end, no question at all, and a question too long to be short', () => {
    expect(notOneShortQuestion('Cooler or warmer? Which room?')).toBe(true);
    expect(notOneShortQuestion('What should I change? Tell me the room.')).toBe(true);
    expect(notOneShortQuestion('I can make the house cooler.')).toBe(true);
    expect(
      notOneShortQuestion(
        'Would you like me to make the living room cooler this afternoon, or keep the battery for the storm reserve tonight, or start a comfort plan for Leo, or something else entirely?',
      ),
    ).toBe(true);
  });
});

describe('a refusal said first (#537 review)', () => {
  const refused = ["Error: No — cooling the living room too: by 07:50 the battery would be at 67 %, not the 83 % set aside for Leo's room."];
  it('"No — …", "No, …" and a word of refusal say it; "No problem" does not', () => {
    expect(refusalNotSaidFirst("No — cooling the living room too: the battery would fall short. This plan holds instead.", refused)).toBe(false);
    expect(refusalNotSaidFirst('No, I cannot cool the living room too: the battery would fall short.', refused)).toBe(false);
    expect(refusalNotSaidFirst('The safety check refused cooling the living room too.', refused)).toBe(false);
    expect(refusalNotSaidFirst("No problem, Leo's room stays cool until 07:50.", refused)).toBe(true);
  });
});
