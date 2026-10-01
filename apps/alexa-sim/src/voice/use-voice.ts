import { useEffect, useMemo, useRef } from 'react';
import type { VoiceConfig } from '../config.js';
import type { ConversationEvent, VoiceSettings } from '../machine.js';
import { createFakeVoice, type FakeVoiceDriver } from './fake-voice.js';
import { createBrowserRecognizer, createBrowserSpeaker, recognitionCtor, type Recognizer, type Speaker, type SynthesisLike, type UtteranceLike } from './speech.js';

// Picks the voice adapters once per page: the browser's (Web Speech), or the scripted fake of the
// E2E tests. No mic without SpeechRecognition, no spoken replies without speechSynthesis: text always works.

declare global {
  interface Window {
    /** Dev-only driver of the voice E2E tests (?voice=fake). */
    __voiceTest?: FakeVoiceDriver;
  }
}

export interface Voice {
  recognizer: Recognizer | null;
  speaker: Speaker | null;
  settings: VoiceSettings;
}

const newTurnId = () => crypto.randomUUID();

function browserAdapters(config: VoiceConfig, send: (event: ConversationEvent) => void) {
  const ctor = recognitionCtor(window);
  const recognizer = ctor === null ? null : createBrowserRecognizer(ctor, { lang: config.lang, send, newTurnId });
  if (!('speechSynthesis' in window)) return { recognizer, speaker: null };
  const speaker = createBrowserSpeaker({
    synth: window.speechSynthesis as unknown as SynthesisLike,
    utterance: (text) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
    lang: config.lang,
    online: () => navigator.onLine,
    ...(config.voiceName !== undefined && { voiceName: config.voiceName }),
    send,
  });
  speaker.warmUp();
  return { recognizer, speaker };
}

/** `send` may change between renders; the adapters always reach the current one. */
export function useVoice(config: VoiceConfig, send: (event: ConversationEvent) => void): Voice {
  const sendRef = useRef(send);
  sendRef.current = send;
  const adapters = useMemo(() => {
    const relay = (event: ConversationEvent) => {
      sendRef.current(event);
    };
    if (config.speech === 'fake') return createFakeVoice(relay, newTurnId);
    return { ...browserAdapters(config, relay), driver: undefined };
  }, [config]);

  useEffect(() => {
    if (adapters.driver === undefined) return;
    window.__voiceTest = adapters.driver;
    return () => {
      delete window.__voiceTest;
    };
  }, [adapters]);

  return {
    recognizer: adapters.recognizer,
    speaker: adapters.speaker,
    settings: {
      micAvailable: adapters.recognizer !== null,
      speakReplies: config.speakReplies && adapters.speaker !== null,
      listenTimeoutMs: config.listenTimeoutMs,
      speakStartTimeoutMs: config.speakStartTimeoutMs,
      speakTimeoutBaseMs: config.speakTimeoutBaseMs,
      speakTimeoutPerCharMs: config.speakTimeoutPerCharMs,
    },
  };
}
