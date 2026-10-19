// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { VoiceBar, voiceBarState } from '../../src/ui/VoiceBar.js';

// The light at the bottom of the Echo screen (#432 S6; Amazon Help "Indicators for Alexa+ on Echo Devices with a
// Screen"): it pulses while listening, runs as a wave while thinking, rests as a small dot while ready to listen again
// (Follow Up), and is off while the answer is spoken. Always there, not only in demo mode. Our colour and shape
// (owner Q2, 18 Oct): never Alexa's blue.

afterEach(cleanup);

describe('voiceBarState', () => {
  it('listening, thinking and ready show; speaking and nothing going on leave it off', () => {
    const none = { listening: false, thinking: false, speaking: false, followUp: false };
    expect(voiceBarState(none)).toBe('off');
    expect(voiceBarState({ ...none, listening: true })).toBe('listening');
    expect(voiceBarState({ ...none, thinking: true })).toBe('thinking');
    expect(voiceBarState({ ...none, speaking: true })).toBe('off');
    expect(voiceBarState({ ...none, followUp: true })).toBe('ready');
    // Follow Up listens: the pulse wins over the dot.
    expect(voiceBarState({ ...none, followUp: true, listening: true })).toBe('listening');
  });
});

describe('VoiceBar', () => {
  it('is decoration for screen readers (the status line says the same in words) and carries its state', () => {
    const { rerender } = render(<VoiceBar state="thinking" />);
    const bar = screen.getByTestId('voice-bar');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(bar.dataset['state']).toBe('thinking');
    rerender(<VoiceBar state="off" />);
    expect(screen.getByTestId('voice-bar').dataset['state']).toBe('off');
  });
});
