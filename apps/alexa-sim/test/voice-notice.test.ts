import { describe, expect, it } from 'vitest';
import { privacyNotice, voiceNotice } from '../src/voice/voice-notice.js';

// What the person reads after a voice problem (plan §11.2 p.10): one reprompt, then text.

describe('voiceNotice', () => {
  it('says nothing without a voice problem', () => {
    expect(voiceNotice({ voiceError: null, suggestText: false })).toBeNull();
  });

  it('reprompts after the first miss, then suggests typing', () => {
    expect(voiceNotice({ voiceError: 'no_speech', suggestText: false })).toBe('voice.reprompt');
    expect(voiceNotice({ voiceError: 'recognition_network', suggestText: true })).toBe('voice.typeInstead');
  });

  it.each(['mic_permission_denied', 'language_not_supported', 'audio_capture_failed'] as const)('points to text when the mic itself is out (%s)', (code) => {
    expect(voiceNotice({ voiceError: code, suggestText: false })).toBe('voice.micBlocked');
  });

  it.each(['speech_synthesis_failed', 'speech_start_missing', 'speech_end_missing'] as const)('says the answer is on screen when it could not be read aloud (%s)', (code) => {
    expect(voiceNotice({ voiceError: code, suggestText: false })).toBe('voice.silent');
  });
});

describe('privacyNotice (#133 review): what may leave the device, said whenever it happens', () => {
  it('covers the mic and the answers read aloud', () => {
    expect(privacyNotice({ micAvailable: true, speakReplies: true })).toBe('voice.privacy');
    expect(privacyNotice({ micAvailable: true, speakReplies: false })).toBe('voice.privacyMic');
    expect(privacyNotice({ micAvailable: false, speakReplies: true })).toBe('voice.privacyReplies');
    expect(privacyNotice({ micAvailable: false, speakReplies: false })).toBeNull();
  });
});
