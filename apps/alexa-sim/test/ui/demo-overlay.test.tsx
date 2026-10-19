// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoOverlay } from '../../src/ui/DemoOverlay.js';

// Demo mode for the video: what the person said as a caption (a help for the video; the light bar is the VoiceBar).

afterEach(cleanup);

describe('DemoOverlay', () => {
  it('captions what the person said, in quotes', () => {
    render(<DemoOverlay said="It's going to be 36 degrees tomorrow." />);
    expect(screen.getByTestId('demo-caption').textContent).toBe('You said: “It\'s going to be 36 degrees tomorrow.”');
  });

  it('no caption before the first question', () => {
    render(<DemoOverlay said={null} />);
    expect(screen.queryByTestId('demo-caption')).toBeNull();
  });
});
