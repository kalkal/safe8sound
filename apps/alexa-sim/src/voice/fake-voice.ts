import type { VoiceErrorCode } from '../machine.js';
import type { Recognizer, Send, Speaker } from './speech.js';

// Scripted voice for the E2E tests (?voice=fake, dev only): no mic, no voices, no network.
// The test drives the person and the speakers through `window.__voiceTest` (see main.tsx).

export interface FakeVoiceDriver {
  listening(): boolean;
  /** The person says these words; false when the mic is closed (the browser would drop them). */
  say(transcript: string): boolean;
  endListening(): void;
  failListening(code: VoiceErrorCode): void;
  speaking(): boolean;
  spoken(): readonly string[];
  startAudio(): void;
  finishAudio(): void;
  failAudio(): void;
}

export function createFakeVoice(send: Send, newTurnId: () => string): { recognizer: Recognizer; speaker: Speaker; driver: FakeVoiceDriver } {
  let listening = false;
  let speaking = false;
  const spoken: string[] = [];
  const whileListening = (action: () => void) => {
    if (!listening) return false;
    listening = false;
    action();
    return true;
  };
  const whileSpeaking = (action: () => void, done: boolean) => {
    if (!speaking) return;
    if (done) speaking = false;
    action();
  };
  return {
    recognizer: {
      start: () => {
        listening = true;
      },
      stop: () => {
        listening = false;
      },
    },
    speaker: {
      speak: (text) => {
        spoken.push(text);
        speaking = true;
      },
      cancel: () => {
        speaking = false;
      },
    },
    driver: {
      listening: () => listening,
      say: (transcript) => whileListening(() => { send({ type: 'SPEECH_RECOGNISED', transcript, turnId: newTurnId() }); }),
      endListening: () => void whileListening(() => { send({ type: 'RECOGNITION_ENDED' }); }),
      failListening: (code) => void whileListening(() => { send({ type: 'RECOGNITION_FAILED', code }); }),
      speaking: () => speaking,
      spoken: () => [...spoken],
      startAudio: () => { whileSpeaking(() => { send({ type: 'SPEAKING_STARTED' }); }, false); },
      finishAudio: () => { whileSpeaking(() => { send({ type: 'SPEAKING_ENDED' }); }, true); },
      failAudio: () => { whileSpeaking(() => { send({ type: 'SPEAKING_FAILED' }); }, true); },
    },
  };
}
