// Rules on the words the assistant says (found on the real site, 20 Oct): one place for the evals of the agent and for the
// journeys that read the real model's answers. Light and robust: patterns for a kind of mistake, never an exact sentence.

import { STORM_NOT_FORECAST_START } from '@cold-reserve/contracts';

export interface AnswerRule {
  readonly id: string;
  /** What is wrong, for the report. */
  readonly says: string;
  readonly pattern: RegExp;
}

export const ANSWER_RULES: readonly AnswerRule[] = [
  {
    id: 'room-named-after-person',
    says: 'a room named after the person in it ("Grandpa\'s room") instead of the name the home gives ("Leo\'s room")',
    pattern: /\b(?:grandpa|grandma|granddad|grandad|grandfather|grandmother)(?:'|’)?s (?:room|bedroom)\b/i,
  },
  {
    id: 'twelve-hour-time',
    says: 'a time in 12 hours (AM or PM) next to cards and messages that write 24 hours',
    pattern: /\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)(?![A-Za-z])/i,
  },
  {
    id: 'internal-id',
    says: 'an internal id read aloud (a room id, a plan id or a sandbox id)',
    pattern: /\b(?:bedroom-\d|living-room|plan_[A-Za-z0-9]{4,}|demo#)/i,
  },
];

/**
 * A refusal that names a temperature the person never asked for ("The safety check refused 36 degrees" to someone who said
 * "It's going to be 36 degrees tomorrow, keep Leo cool": the forecast taken as a setpoint, 21 Oct). The number is the person's
 * own ask only when their question puts it after a verb that sets or wants a temperature ("set every room to 21 degrees",
 * "lower every room to 21", "can I have 21 degrees in every room"). Only a number straight after the word counts as the
 * refused one: "refused that plan: Leo's room would reach 31 degrees" names a result, not the person's ask. In a question in
 * °F the refusal may say the °C equivalent ("refused 22.2 °C" for "set the study to 72 degrees Fahrenheit").
 */
const REFUSED_NUMBER = /\brefus(?:ed|es)\s+(?:to\s+set\s+|the\s+|a\s+)?(\d+(?:\.\d+)?)\s?(?:degrees|°)/i;
const SETTING_VERBS = /\b(?:set|cool|heat|warm|keep|make|put|turn|lower|raise|drop|bring|have|want|need|get|hold)\b(?:[^.?!]|\.(?=\d))*/gi;
const FAHRENHEIT = /°\s?F\b|\bfahrenheit\b|\bdegrees F\b/i;

/** The numbers a question puts after a verb that sets or wants a temperature. */
function askedNumbers(question: string): number[] {
  const numbers: number[] = [];
  for (const part of question.matchAll(SETTING_VERBS)) for (const n of part[0].matchAll(/\d+(?:\.\d+)?/g)) numbers.push(Number(n[0]));
  return numbers;
}

export function refusalNamesUnaskedNumber(answer: string, question: string): boolean {
  const named = REFUSED_NUMBER.exec(answer)?.[1];
  if (named === undefined) return false;
  const value = Number(named);
  const inFahrenheit = FAHRENHEIT.test(question);
  return !askedNumbers(question).some((asked) => asked === value || (inFahrenheit && Math.abs(((asked - 32) * 5) / 9 - value) <= 0.1));
}

const ASKS_TO_GET_READY = /\?/;
const SAYS_NOTHING_STARTED = /\b(?:nothing (?:was|has been) started|no storm (?:was|has been) started|no storm (?:is|was) (?:forecast|expected)|the forecast (?:i read )?(?:shows|reads|says) no storm|not (?:started|prepared)|did(?: not|n['’]t) (?:start|prepare)|no one (?:was|has been) told|nobody (?:was|has been) told|(?:haven['’]t|have not|did not|didn['’]t) (?:told|notified|informed))\b/i;
const CLAIMS_IT_DID = /\b(?:i(?:['’]ve| have)? (?:prepared|started|told|notified|informed|alerted)|(?:storm mode is|the home is) (?:ready|prepared|active)|(?:the )?family (?:was|has been|is) (?:told|notified|informed)|(?:a )?storm is (?:expected|forecast|coming))\b/i;

/**
 * A storm-mode request the home did not start (grid on, no storm forecast, 21 Oct: the model said "I told the family a storm is
 * expected" after the owner said the power went out): the answer must say the forecast shows no storm or that nothing was
 * started, ask whether to get the home ready anyway, and never claim it started, told anyone or that a storm is coming.
 */
export function ignoresStormRefusal(answer: string, toolResults: readonly string[]): boolean {
  if (!toolResults.some((r) => r.includes(STORM_NOT_FORECAST_START))) return false;
  const honest = SAYS_NOTHING_STARTED.test(answer) && ASKS_TO_GET_READY.test(answer);
  return !honest || CLAIMS_IT_DID.test(answer.replace(SAYS_NOTHING_STARTED, ''));
}

/** A plan result that opens with the guard's refusal of the proposal (the card's own sentence; the fake world words it "...refused the plan you proposed"). */
const PLAN_REFUSED = /^(?:Error: )?The safety check refused the (?:proposed plan|plan you proposed)/;

/**
 * A plan the guard refused (21 Oct: the voice said the plan and "9 hours" over a card that said "0 of 6" and never said the
 * refusal): the first sentence of the answer names it, as the prompt asks ("say that first").
 */
export function refusalNotSaidFirst(answer: string, toolResults: readonly string[]): boolean {
  if (!toolResults.some((r) => PLAN_REFUSED.test(r))) return false;
  // A point between two digits ("21.5") does not end the sentence.
  const first = /^(?:[^.?!]|\.(?=\d))*[.?!]/.exec(answer.trim())?.[0] ?? answer;
  return !/\brefus/i.test(first);
}

/** The ids of the rules the text breaks, in order. With the question and the tool results, also the rules that compare the answer with them. */
export function answerRuleViolations(text: string, question?: string, toolResults: readonly string[] = []): string[] {
  const broken = ANSWER_RULES.filter((r) => r.pattern.test(text)).map((r) => r.id);
  if (question !== undefined && refusalNamesUnaskedNumber(text, question)) broken.push('refusal-names-unasked-number');
  if (ignoresStormRefusal(text, toolResults)) broken.push('ignores-storm-refusal');
  if (refusalNotSaidFirst(text, toolResults)) broken.push('refusal-not-said-first');
  return broken;
}

/**
 * The assistant asks the person to confirm or to say yes before starting THE plan. A follow-up about something else ("Should
 * I start storm prepare too?") is a good answer and is not matched.
 */
export const ASKS_CONFIRMATION = /\b(?:please confirm|confirm (?:it|this|the plan)|(?:shall|should) i (?:start|apply|go ahead with) (?:it|this|the plan|that plan)|do you want me to (?:start|apply|go ahead with) (?:it|this|the plan|that plan)|say (?:"|\u201c)?yes)\b/i;

/** A card that says the plan is already in place ("Plan applied.", "The plan was already applied."). */
export const SAYS_PLAN_APPLIED = /\bplan (?:was )?(?:already )?applied\b/i;

/** The words of an answer and of the cards next to it contradict each other: it asks to confirm a plan a card shows as applied. */
export function asksToConfirmAnAppliedPlan(answer: string, cardsText: string): boolean {
  return SAYS_PLAN_APPLIED.test(cardsText) && ASKS_CONFIRMATION.test(answer);
}

/** The most words a clarifying answer may take and still be one short question (a short lead-in included: the honest answer to "Yes, confirm it." with nothing to confirm takes about 24). */
const SHORT_QUESTION_WORDS = 30;

/**
 * A request too unclear to act on gets one short question back (21 Oct: the real model answered "Make it better." with a
 * list of three questions and an instruction): exactly one "?", at the very end, in a few words.
 */
export function notOneShortQuestion(answer: string): boolean {
  // Closing quotes, brackets and spaces after the question mark do not count (“Which room?”).
  const text = answer.trim().replace(/[\s"'’”)\]]+$/, '');
  return text.split('?').length !== 2 || !text.endsWith('?') || text.split(/\s+/).length > SHORT_QUESTION_WORDS;
}
