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

/** The ids of the rules the text breaks, in order. */
export function answerRuleViolations(text: string): string[] {
  return ANSWER_RULES.filter((r) => r.pattern.test(text)).map((r) => r.id);
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
