// Rules on the words the assistant says (found on the real site, 20 Oct): one place for the evals of the agent and for the
// journeys that read the real model's answers. Light and robust: patterns for a kind of mistake, never an exact sentence.

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

/** The ids of the rules the text breaks, in order. With the question, also the rules that compare the answer with it. */
export function answerRuleViolations(text: string, question?: string): string[] {
  const broken = ANSWER_RULES.filter((r) => r.pattern.test(text)).map((r) => r.id);
  return question !== undefined && refusalNamesUnaskedNumber(text, question) ? [...broken, 'refusal-names-unasked-number'] : broken;
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
