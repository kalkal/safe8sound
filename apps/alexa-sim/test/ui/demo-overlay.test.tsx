// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoOverlay } from '../../src/ui/DemoOverlay.js';

// Demo mode for the video: what the person said as a caption, and the light bar while Alexa speaks.

afterEach(cleanup);

describe('DemoOverlay', () => {
  it('captions what the person said, in quotes', () => {
    render(<DemoOverlay said="It's going to be 36 degrees tomorrow." speaking={false} />);
    expect(screen.getByTestId('demo-caption').textContent).toBe('You said: “It\'s going to be 36 degrees tomorrow.”');
  });

  it('no caption before the first question', () => {
    render(<DemoOverlay said={null} speaking={false} />);
    expect(screen.queryByTestId('demo-caption')).toBeNull();
  });

  it('the light bar is lit only while Alexa speaks, and is decoration for screen readers', () => {
    const { rerender } = render(<DemoOverlay said={null} speaking />);
    const bar = screen.getByTestId('demo-light-bar');
    expect(bar.dataset['lit']).toBe('true');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    rerender(<DemoOverlay said={null} speaking={false} />);
    expect(screen.getByTestId('demo-light-bar').dataset['lit']).toBe('false');
  });
});
