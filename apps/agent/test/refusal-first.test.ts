import type { ToolCard } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { refusalFirst } from '../src/refusal-first.js';

// 22 Oct, on the real site after #502: the card said "The safety check refused the proposed plan: …" and the voice said
// "I can keep Leo's room under 26.5 degrees … Shall I start?". The server makes the voice and the card say the same: when
// a tool result of the turn carries the guard's refusal and the answer's first sentence does not name it, the card's own
// sentence (plan.refusedProposal) opens the answer. The prompt is untouched.

const MESSAGE = "No — cooling the living room too: Leo's room would reach 31 °C, over its 28 °C limit.";
const SENTENCE = `${MESSAGE} This plan holds instead.`;
// The plan card as the recorder keeps it: only the field this guarantee reads matters here.
const refusedCard = { tool: 'plan_comfort', result: { refusedProposal: { code: 'guarantee_failed', message: MESSAGE } } } as unknown as ToolCard;
const plainCard = { tool: 'plan_comfort', result: {} } as unknown as ToolCard;
const refusedResult = `${SENTENCE} It is ready to apply.`;

describe('the refusal said first, by the server (22 Oct)', () => {
  it('an answer that does not name the refusal opens with the card sentence', () => {
    const answer = "I can keep Leo's room under 26.5 degrees until 07:00. Shall I start?";
    expect(refusalFirst(answer, [refusedCard], [refusedResult])).toEqual({ text: `${SENTENCE} ${answer}`, prepended: true });
  });

  it('an answer that already says it first is unchanged', () => {
    const answer = 'The safety check refused the first plan: it let the room get too hot. This one keeps it under 26.5 degrees.';
    expect(refusalFirst(answer, [refusedCard], [refusedResult])).toEqual({ text: answer, prepended: false });
  });

  it('no refusal in the turn: unchanged', () => {
    const answer = "I can keep Leo's room under 26.5 degrees until 07:00. Shall I start?";
    expect(refusalFirst(answer, [plainCard], ['Plan plan_1 holds every guarantee.'])).toEqual({ text: answer, prepended: false });
  });

  it('a refusal in the tool results but no card that carries it: unchanged, never a sentence made up', () => {
    const answer = 'Here is the plan. Shall I start?';
    expect(refusalFirst(answer, [plainCard], [refusedResult])).toEqual({ text: answer, prepended: false });
  });
});

describe('the live miss of 23 Oct, 10:34 (scene 2, Turin hot day)', () => {
  it('the voice offered the plan as if nothing was refused: the card\'s sentence now opens the answer', () => {
    const message = "No — cooling the living room too: by 07:50 the battery would be at 67 %, not the 83 % set aside for Leo's room.";
    const card = { tool: 'plan_comfort', result: { refusedProposal: { code: 'pacing_off_track', message } } } as unknown as ToolCard;
    const tool = `${message} This plan holds instead. It is ready to apply.`;
    const answer = "I can keep the living room cool and the whole home comfortable until 08:00 while still holding 4.4 kWh for a storm. The plan is ready; please confirm and I'll start it.";
    const said = refusalFirst(answer, [card], [tool]);
    expect(said.prepended).toBe(true);
    expect(said.text).toBe(`${message} This plan holds instead. ${answer}`);
  });
});
