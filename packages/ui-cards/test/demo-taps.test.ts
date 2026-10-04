// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_CONTEXT_KEY, TAP_MARK_MS, installTapMarks, isDemoContext } from '../src/demo-taps.js';

// Demo mode for the video (scene recording): each tap leaves a short circle where the pointer pressed, so a
// viewer sees what was touched. Off unless the host turns it on; never in a real Alexa+ host.

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const press = (x: number, y: number) => {
  // jsdom has no PointerEvent constructor: a MouseEvent of type pointerdown carries the same coordinates.
  document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
};

describe('tap marks', () => {
  it('a press leaves a circle centred on the pointer, hidden from screen readers, gone after a moment', () => {
    vi.useFakeTimers();
    const uninstall = installTapMarks(document);
    press(120, 48);
    const mark = document.querySelector<HTMLElement>('.demo-tap');
    expect(mark?.style.left).toBe('120px');
    expect(mark?.style.top).toBe('48px');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    vi.advanceTimersByTime(TAP_MARK_MS);
    expect(document.querySelector('.demo-tap')).toBeNull();
    uninstall();
  });

  it('is drawn with style properties and tokens only: the inline style of the card and the site CSP stay as they are', () => {
    const uninstall = installTapMarks(document);
    press(5, 5);
    const mark = document.querySelector<HTMLElement>('.demo-tap');
    expect(mark?.style.position).toBe('fixed');
    expect(mark?.style.pointerEvents).toBe('none');
    expect(mark?.style.inlineSize).toBe('var(--target-min)');
    expect(document.querySelectorAll('style')).toHaveLength(0);
    uninstall();
  });

  it('grows and fades with the Web Animations API, and with reduced motion stays still', () => {
    const animate = vi.fn();
    const proto = HTMLElement.prototype as unknown as { animate?: unknown };
    const before = proto.animate;
    proto.animate = animate;
    const reduce = { matches: false };
    vi.stubGlobal('matchMedia', () => reduce);
    try {
      const uninstall = installTapMarks(document);
      press(1, 1);
      expect(animate).toHaveBeenCalledOnce();
      expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: TAP_MARK_MS, fill: 'forwards' });
      reduce.matches = true;
      press(2, 2);
      expect(animate).toHaveBeenCalledOnce();
      uninstall();
    } finally {
      proto.animate = before;
      vi.unstubAllGlobals();
    }
  });

  it('never blocks the press: the mark lets the pointer through and the event goes on', () => {
    const uninstall = installTapMarks(document);
    const onDown = vi.fn();
    document.body.addEventListener('pointerdown', onDown);
    press(10, 10);
    expect(onDown).toHaveBeenCalledOnce();
    expect(document.querySelector('.demo-tap')?.classList.contains('demo-tap')).toBe(true);
    uninstall();
  });

  it('after uninstall a press leaves nothing, and the marks still on screen are removed', () => {
    const uninstall = installTapMarks(document);
    press(1, 1);
    uninstall();
    expect(document.querySelector('.demo-tap')).toBeNull();
    press(2, 2);
    expect(document.querySelector('.demo-tap')).toBeNull();
  });

  it('the host turns demo mode on with its own hostContext key, and only with true', () => {
    expect(isDemoContext({ [DEMO_CONTEXT_KEY]: true })).toBe(true);
    expect(isDemoContext({ [DEMO_CONTEXT_KEY]: 'true' })).toBe(false);
    expect(isDemoContext({ theme: 'dark' })).toBe(false);
    expect(isDemoContext(undefined)).toBe(false);
  });
});
