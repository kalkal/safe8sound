import { describe, expect, it } from 'vitest';
import { createTurnTimer, percentile } from '../src/latency';

function clock(times: number[]) {
  let i = 0;
  return () => times[i++] ?? Number.NaN;
}

describe('createTurnTimer', () => {
  it('measures a voice turn from the end of the user speech', () => {
    const t = createTurnTimer(clock([1000, 1400, 1650, 1900, 4000]));
    t.mark('speechEnd');
    t.mark('recognised');
    t.mark('replyReady');
    t.mark('audioStart');
    t.mark('audioEnd');
    expect(t.summary()).toEqual({
      recognitionMs: 400,
      replyMs: 250,
      ttsStartMs: 250,
      perceivedMs: 900,
      speakingMs: 2100,
    });
  });

  it('measures a typed turn from the submission', () => {
    const t = createTurnTimer(clock([0, 300, 380]));
    t.mark('submitted');
    t.mark('replyReady');
    t.mark('audioStart');
    expect(t.summary()).toEqual({ recognitionMs: null, replyMs: 300, ttsStartMs: 80, perceivedMs: 380, speakingMs: null });
  });

  it('falls back to the recognised mark when speechend never fired', () => {
    const t = createTurnTimer(clock([500, 700, 750]));
    t.mark('recognised');
    t.mark('replyReady');
    t.mark('audioStart');
    expect(t.summary().perceivedMs).toBe(250);
    expect(t.summary().recognitionMs).toBeNull();
  });

  it('keeps the first value of a repeated mark', () => {
    const t = createTurnTimer(clock([10, 30, 99]));
    t.mark('submitted');
    t.mark('submitted');
    t.mark('replyReady');
    expect(t.summary().replyMs).toBe(20);
  });

  it('reset starts a fresh turn', () => {
    const t = createTurnTimer(clock([0, 5, 100]));
    t.mark('submitted');
    t.mark('replyReady');
    t.reset();
    t.mark('audioStart');
    expect(t.summary()).toEqual({ recognitionMs: null, replyMs: null, ttsStartMs: null, perceivedMs: null, speakingMs: null });
  });
});

describe('percentile', () => {
  it('uses nearest-rank', () => {
    const xs = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile(xs, 0)).toBe(1);
  });

  it('returns null for an empty list', () => {
    expect(percentile([], 50)).toBeNull();
  });
});
