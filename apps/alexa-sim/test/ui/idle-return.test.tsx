// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIdleReturn } from '../../src/ui/idle-return.js';

// #432 S6 (owner, 18 Oct): an answer leaves the screen a minute after the last touch, key or spoken word, and the idle
// screen comes back, as a real Echo Show cleans itself. Never while something waits for the person: a card at full
// screen or a sheet open (a modal dialog), or the person reading inside a card (the focus in its frame). The caller
// says when the clock runs (an answer on screen, the voice done, no plan waiting for its choice). 60 s is our choice:
// Amazon publishes no value for the Echo Show.

const DELAY = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function start(active = true) {
  const onReturn = vi.fn();
  const hook = renderHook(({ on }) => {
    useIdleReturn({ active: on, delayMs: DELAY, onReturn });
  }, { initialProps: { on: active } });
  return { onReturn, hook };
}

describe('useIdleReturn', () => {
  it('returns to the idle screen once, the delay after it started running', () => {
    const { onReturn } = start();
    vi.advanceTimersByTime(DELAY - 1);
    expect(onReturn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DELAY * 3);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('a touch, a key or a scroll starts the minute again', () => {
    const { onReturn } = start();
    for (const type of ['pointerdown', 'keydown', 'wheel']) {
      vi.advanceTimersByTime(DELAY - 1000);
      window.dispatchEvent(new Event(type));
    }
    vi.advanceTimersByTime(DELAY - 1);
    expect(onReturn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('does not run while the caller says so (a turn on its way, the voice reading, a plan waiting for its choice)', () => {
    const { onReturn, hook } = start(false);
    vi.advanceTimersByTime(DELAY * 2);
    expect(onReturn).not.toHaveBeenCalled();
    hook.rerender({ on: true });
    vi.advanceTimersByTime(DELAY / 2);
    hook.rerender({ on: false });
    vi.advanceTimersByTime(DELAY);
    expect(onReturn).not.toHaveBeenCalled();
    hook.rerender({ on: true });
    vi.advanceTimersByTime(DELAY);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('waits while a modal dialog is open (a card at full screen, a sheet) or the focus is inside a card, then waits a full minute more', () => {
    const { onReturn } = start();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    vi.advanceTimersByTime(DELAY * 2);
    expect(onReturn).not.toHaveBeenCalled();
    dialog.remove();
    const frame = document.createElement('iframe');
    document.body.append(frame);
    frame.focus();
    expect(document.activeElement).toBe(frame);
    vi.advanceTimersByTime(DELAY * 2);
    expect(onReturn).not.toHaveBeenCalled();
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    vi.advanceTimersByTime(DELAY);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});
