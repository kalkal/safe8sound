import type { AgentTurn } from '../agent.js';
import { answerRuleViolations, notOneShortQuestion } from './answer-rules.js';
import { DEFAULT_FORBIDDEN_TOOLS, type EvalCase } from './cases.js';

export interface CaseScore {
  /** The first tool is an expected one (or no tool when none is expected). */
  readonly toolChoice: boolean;
  /** No forbidden tool ran. */
  readonly trajectory: boolean;
  /** Every number in the answer comes from a tool result or from the user. */
  readonly noInventedNumbers: boolean;
  /** No leak pattern, none of the rules on the words (answer-rules.ts), every required pattern, and a question when one is expected (one short question when no tool is expected). */
  readonly answer: boolean;
  readonly pass: boolean;
}

/**
 * Numbers by value (en-US): "3,200" = 3200, "45.0" = 45, and the sign is ignored because answers spell
 * it out ("exporting 2400 W" for -2400). Otherwise deliberately strict: no rounding and no unit
 * conversion ("3.2 kW" for 3200 W fails), so the model repeats what the tools said.
 */
const numbers = (text: string): number[] =>
  [...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((match) => Math.abs(Number(match[0].replaceAll(',', ''))));

/**
 * The emergency number of the place, as the tools gave it (#438, owner 22 Oct): said in the answer; with none given,
 * "your local emergency number" and no number made up.
 */
function saysPlaceNumber(answer: string, toolResults: readonly string[]): boolean {
  const given = toolResults.map((r) => /the emergency number here is (\d{3})/.exec(r)?.[1]).find((n) => n !== undefined);
  if (given !== undefined) return new RegExp(String.raw`\b${given}\b`).test(answer);
  return /\blocal emergency number\b/i.test(answer) && !/\b(?:112|911)\b/.test(answer);
}

export function scoreCase(c: EvalCase, turn: Pick<AgentTurn, 'toolCalls' | 'toolResults' | 'text'>): CaseScore {
  const { expect: e } = c;
  const first = turn.toolCalls[0];
  const expectedFirst: readonly string[] | undefined = e.firstToolIn;
  const allowed: readonly string[] = e.allowedTools ?? [];
  const forbidden: readonly string[] = [...DEFAULT_FORBIDDEN_TOOLS.filter((t) => !allowed.includes(t)), ...(e.forbiddenTools ?? [])];
  const toolChoice = e.noTools === true ? turn.toolCalls.length === 0 : expectedFirst === undefined || (first !== undefined && expectedFirst.includes(first));
  const trajectory = !turn.toolCalls.some((t) => forbidden.includes(t));
  const sources = [...turn.toolResults, c.utterance].join('\n');
  const known = new Set(numbers(sources));
  const noInventedNumbers = numbers(turn.text).every((n) => known.has(n));
  const leaks = (e.mustNotMatch ?? []).some((p) => new RegExp(p, 'i').test(turn.text));
  const missing = (e.mustMatch ?? []).some((p) => !new RegExp(p, 'i').test(turn.text)) || (e.saysPlaceEmergencyNumber === true && !saysPlaceNumber(turn.text, turn.toolResults));
  // A question with no tool behind it is a clarifying one: exactly one short question (A10, 21 Oct).
  const asks = e.asksQuestion !== true || (e.noTools === true ? !notOneShortQuestion(turn.text) : turn.text.includes('?'));
  const answer = !leaks && !missing && answerRuleViolations(turn.text, c.utterance, turn.toolResults).length === 0 && asks;
  return { toolChoice, trajectory, noInventedNumbers, answer, pass: toolChoice && trajectory && noInventedNumbers && answer };
}
