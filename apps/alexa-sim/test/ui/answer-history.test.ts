import { describe, expect, it } from 'vitest';
import { ANSWER_HISTORY_MAX, addAnswer, answerMoment, backToStart, currentAnswer, emptyHistory, historyPosition, stepAnswer } from '../../src/ui/answer-history.js';

// Owner's choice (10 Oct): the screen shows one answer at a time; Previous / Next go through the earlier ones.

describe('answer history', () => {
  it('starts empty: no answer, no position', () => {
    expect(currentAnswer(emptyHistory)).toBeUndefined();
    expect(historyPosition(emptyHistory)).toBeUndefined();
  });

  it('a new answer is added at the end and shown at once', () => {
    const h = addAnswer(addAnswer(emptyHistory, 't1'), 't2');
    expect(currentAnswer(h)).toBe('t2');
    expect(historyPosition(h)).toEqual({ n: 2, of: 2, hasPrevious: true, hasNext: false });
  });

  it('Previous and Next move one answer, and stop at both ends', () => {
    let h = addAnswer(addAnswer(addAnswer(emptyHistory, 't1'), 't2'), 't3');
    h = stepAnswer(h, -1);
    expect(currentAnswer(h)).toBe('t2');
    h = stepAnswer(stepAnswer(h, -1), -1);
    expect(currentAnswer(h)).toBe('t1');
    expect(historyPosition(h)).toEqual({ n: 1, of: 3, hasPrevious: false, hasNext: true });
    h = stepAnswer(stepAnswer(stepAnswer(h, 1), 1), 1);
    expect(currentAnswer(h)).toBe('t3');
  });

  it('the same turn twice (a retry, a re-render) is one answer, shown again', () => {
    let h = addAnswer(addAnswer(emptyHistory, 't1'), 't2');
    h = stepAnswer(h, -1);
    h = addAnswer(h, 't2');
    expect(h.turns).toEqual(['t1', 't2']);
    expect(currentAnswer(h)).toBe('t2');
  });

  it('keeps the last answers only, so the page never grows without end', () => {
    let h = emptyHistory;
    for (let i = 0; i < ANSWER_HISTORY_MAX + 3; i++) h = addAnswer(h, `t${String(i)}`);
    expect(h.turns).toHaveLength(ANSWER_HISTORY_MAX);
    expect(h.turns[0]).toBe('t3');
    expect(currentAnswer(h)).toBe(`t${String(ANSWER_HISTORY_MAX + 2)}`);
  });

  it('Back from the first answer (idea 5): the first screen, no answer shown, every answer kept', () => {
    let h = backToStart(addAnswer(addAnswer(emptyHistory, 't1'), 't2'));
    expect(currentAnswer(h)).toBeUndefined();
    expect(historyPosition(h)).toBeUndefined();
    expect(h.turns).toEqual(['t1', 't2']);
    h = addAnswer(h, 't3');
    expect(currentAnswer(h)).toBe('t3');
    expect(historyPosition(h)).toEqual({ n: 3, of: 3, hasPrevious: true, hasNext: false });
  });
});

describe('answerMoment: the simulated time an answer speaks of (owner, 18 Oct)', () => {
  const at = '2026-07-14T15:00:00+02:00';

  it('an answer given now is labelled with its time, not as earlier', () => {
    expect(answerMoment(at, at)).toEqual({ time: '15:00', earlier: false });
  });

  it('the same moment written another way is still now', () => {
    expect(answerMoment(at, '2026-07-14T13:00:00Z')).toEqual({ time: '15:00', earlier: false });
  });

  it('after the clock moves on, the answer is marked earlier: it no longer describes the home', () => {
    expect(answerMoment(at, '2026-07-15T06:40:00+02:00')).toEqual({ time: '15:00', earlier: true });
  });

  it('without a simulated clock when it was given, no label (the shared home, a clock not read yet)', () => {
    expect(answerMoment(undefined, at)).toBeUndefined();
    expect(answerMoment('not a time', at)).toBeUndefined();
  });

  it('a clock not read now keeps the time and does not guess it is earlier', () => {
    expect(answerMoment(at, undefined)).toEqual({ time: '15:00', earlier: false });
  });
});
