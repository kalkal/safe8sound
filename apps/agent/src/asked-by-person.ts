// Who asked for a plan_comfort proposal (owner, 22 Oct): a plan the guard refused is said, briefly with the reason and the
// plan that holds, only when the person asked for what was refused; a proposal the model made up on its own is never said
// nor shown. Decided here, by code, from the person's own words and the call's overrides (setpointC, roomIds), never by the
// model; the MCP wrapper sends it in the call's _meta, which the model can neither see nor set. In doubt: false.

import { EntityIdSchema } from '@cold-reserve/contracts';

/** A verb that sets or wants a temperature, before the number in the same sentence. */
// Not "get" nor "have": "it'll get up to 38", "we have to leave at 5" (review of #518).
const SETTING_VERB = /\b(?:set|keep|cool|heat|warm|make|put|turn|lower|raise|drop|bring|hold|want|need)\b/i;
/** A number the person asks a room to be at: right after "to", "at", "under", "below", "around" or "than". */
const ASKED_NUMBER = /\b(?:to|at|under|below|around|than)\s+(?:about\s+)?(\d+(?:\.\d+)?)(?![\d.])/gi;
/** The weather moving, before the number in the same clause: "it rises to 38", "temperatures climb to 38" (second review of #518). */
const WEATHER_BEFORE = /\b(?:rises?|rising|climbs?|climbing|reach(?:es)?|hits?|goes up|going up)\b/i;
/** A number followed by a time of day, a day or "outside" is weather or an appointment, never a setting ("36 degrees tomorrow", "38 this afternoon", "36 on Saturday"). */
const DAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|the weekend)';
const WEATHER_AFTER = new RegExp(
  String.raw`^\s*(?:°\s?[CF]?|degrees?(?:\s+(?:C|F|celsius|fahrenheit))?)?\s+(?:tomorrow|today|tonight|outside|out there|this (?:morning|afternoon|evening|week|weekend)|(?:on|by) ${DAY})\b`,
  'i',
);

/** The clauses of a question (sentences, and their parts between commas or semicolons); a point between two digits does not end one. */
const clausesOf = (question: string): string[] => question.split(/(?<!\d)[.?!,;]|[.?!,;](?!\d)/);

/** The number is the call's setpoint, as the person said it: in °C, or in °F ("70 degrees" is 21.1 °C). */
const isSetpoint = (n: number, setpointC: number): boolean => Math.abs(n - setpointC) <= 0.05 || Math.abs(((n - 32) * 5) / 9 - setpointC) <= 0.15;

/**
 * The person asked for this setpoint: in one clause, a setting verb, then the setpoint's own number (second review of #518:
 * a time or a forecast later in the sentence is never it), no weather moving before it and no day or time after it.
 */
function asksForTemperature(question: string, setpointC: number): boolean {
  return clausesOf(question).some((clause) =>
    [...clause.matchAll(ASKED_NUMBER)].some((m) => {
      const before = clause.slice(0, m.index);
      return isSetpoint(Number(m[1]), setpointC) && SETTING_VERB.test(before) && !WEATHER_BEFORE.test(before) && !WEATHER_AFTER.test(clause.slice(m.index + m[0].length));
    }),
  );
}

/** The words of a room id a person would say ("living" in "living", "bedroom" in "bedroom-1"). */
const roomWords = (roomId: string): string[] => roomId.split(/[-_]/).filter((w) => w.length >= 3 && !/^\d+$/.test(w));

/**
 * The room ids are the model's own text (security review of #518): only a well-formed entity id counts, and its words are
 * compared with the question's words as plain strings, never built into a pattern.
 */
function namesRoom(question: string, roomIds: readonly unknown[]): boolean {
  const said = new Set(question.toLowerCase().split(/[^a-z0-9]+/));
  return roomIds.some((id) => EntityIdSchema.safeParse(id).success && roomWords(id as string).some((w) => said.has(w)));
}

/**
 * Whether the person asked for the proposal of this plan_comfort call. With a setpoint, only the temperature decides: a room
 * the person named does not make a setpoint the model chose theirs (review of #518). Without one, a room they named.
 */
export function askedByPerson(question: string | undefined, args: Record<string, unknown>): boolean {
  if (question === undefined) return false;
  if (typeof args['setpointC'] === 'number') return asksForTemperature(question, args['setpointC']);
  return Array.isArray(args['roomIds']) && namesRoom(question, args['roomIds'] as unknown[]);
}
