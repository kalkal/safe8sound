// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOW_TURN_NOTICE_MS, useSlowTurn } from '../../src/ui/slow-turn.js';

// #270: a cold AgentCore start can make the first answer take up to the 16 s browser wait. After about 8 s the
// waiting screen says so, honestly, so the wait does not look broken.

describe('useSlowTurn', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('turns on after the notice delay while the turn is still waiting, and off when it ends', () => {
    const { result, rerender } = renderHook(({ waiting }) => useSlowTurn(waiting), { initialProps: { waiting: true } });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(SLOW_TURN_NOTICE_MS - 1);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
    rerender({ waiting: false });
    expect(result.current).toBe(false);
  });

  it('a new turn starts the count again', () => {
    const { result, rerender } = renderHook(({ waiting }) => useSlowTurn(waiting), { initialProps: { waiting: true } });
    act(() => {
      vi.advanceTimersByTime(SLOW_TURN_NOTICE_MS - 1000);
    });
    rerender({ waiting: false });
    rerender({ waiting: true });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current).toBe(false);
  });

  it('the notice comes about halfway through the 16 s browser wait', () => {
    expect(SLOW_TURN_NOTICE_MS).toBe(8000);
  });
});
