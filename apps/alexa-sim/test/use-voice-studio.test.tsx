// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VoiceConfig } from '../src/config.js';
import { privacyNotice } from '../src/voice/voice-notice.js';
import { useVoice, type StudioVoice } from '../src/voice/use-voice.js';

// F8d (#25, review of #183): the hook wires the studio voice in front of the browser voice. With a studio
// voice that fails, the reply is read by the browser voice and the page shows the notice; the privacy
// notice names Amazon Polly. Fake browser objects only: no speech, no audio, no network.

const CONFIG: VoiceConfig = {
  speech: 'browser',
  lang: 'en-US',
  speakReplies: true,
  listenTimeoutMs: 1000,
  followUpMs: 8000,
  speakStartTimeoutMs: 3000,
  studioVoiceTimeoutMs: 1500,
  speakTimeoutBaseMs: 1000,
  speakTimeoutPerCharMs: 10,
};

const spoken: string[] = [];

beforeEach(() => {
  spoken.length = 0;
  Object.assign(window, {
    speechSynthesis: { speak: (u: { text: string }) => spoken.push(u.text), cancel: () => undefined, getVoices: () => [] },
    SpeechSynthesisUtterance: class {
      text: string;
      constructor(text: string) {
        this.text = text;
      }
    },
  });
  Object.assign(globalThis, {
    Audio: class {
      src = '';
      play() {
        return Promise.resolve();
      }
      pause() {
        return undefined;
      }
    },
  });
});

afterEach(cleanup);

describe('useVoice with the studio voice', () => {
  it('reads a failed studio reply with the browser voice, shows the notice once, and names Polly in the privacy notice', async () => {
    const studio: StudioVoice = { synthesize: () => Promise.resolve({ ok: false, code: 'polly_unavailable' }) };
    const { result } = renderHook(() => useVoice(CONFIG, () => undefined, studio));
    expect(result.current.studioVoice).toBe(true);
    expect(result.current.browserVoiceNotice).toBe(false);
    expect(privacyNotice({ micAvailable: false, speakReplies: result.current.settings.speakReplies, studioVoice: result.current.studioVoice })).toBe('voice.privacyStudioReplies');

    await act(async () => {
      result.current.speaker?.speak('Your battery is at 64%.', 'turn-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(spoken.filter((t) => t.trim() !== '')).toEqual(['Your battery is at 64%.']);
    expect(result.current.browserVoiceNotice).toBe(true);
  });

  it('without a studio voice, the browser voice reads directly and the privacy notice does not name Polly', () => {
    const { result } = renderHook(() => useVoice(CONFIG, () => undefined));
    expect(result.current.studioVoice).toBe(false);
    expect(privacyNotice({ micAvailable: false, speakReplies: true, studioVoice: result.current.studioVoice })).toBe('voice.privacyReplies');
  });
});
