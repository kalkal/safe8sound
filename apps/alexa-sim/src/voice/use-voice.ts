import { useEffect, useMemo, useRef, useState } from 'react';
import type { VoiceConfig } from '../config.js';
import type { ConversationEvent, VoiceSettings } from '../machine.js';
import { createFakeVoice, type FakeVoiceDriver } from './fake-voice.js';
import { createPollySpeaker, type AudioLike, type Synthesize } from './polly-speaker.js';
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
  /** The studio voice (Polly) may read the replies: the privacy notice names it. */
  studioVoice: boolean;
  /** The studio voice failed once on this page: the browser voice reads the replies now (one honest notice). */
  browserVoiceNotice: boolean;
}

/** The studio voice of remote mode (F8d, #25): how to fetch a reply's audio from the sim-api. */
export interface StudioVoice {
  synthesize: Synthesize;
}

const newTurnId = () => crypto.randomUUID();

function browserAdapters(config: VoiceConfig, send: (event: ConversationEvent) => void, studio: StudioVoice | undefined, onFallback: () => void) {
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
  if (studio === undefined || typeof Audio === 'undefined') return { recognizer, speaker };
  // The studio voice first; the browser voice reads any reply it cannot (F8d, #25).
  const studioSpeaker = createPollySpeaker({
    synthesize: studio.synthesize,
    timeoutMs: config.studioVoiceTimeoutMs,
    audio: () => new Audio() as unknown as AudioLike,
    objectUrl: { create: (blob) => URL.createObjectURL(blob), revoke: (url) => { URL.revokeObjectURL(url); } },
    fallback: speaker,
    onFallback,
    send,
  });
  return { recognizer, speaker: studioSpeaker };
}

/** `send` may change between renders; the adapters always reach the current one. */
export function useVoice(config: VoiceConfig, send: (event: ConversationEvent) => void, studio?: StudioVoice): Voice {
  const sendRef = useRef(send);
  sendRef.current = send;
  const [browserVoiceNotice, setBrowserVoiceNotice] = useState(false);
  const adapters = useMemo(() => {
    const relay = (event: ConversationEvent) => {
      sendRef.current(event);
    };
    if (config.speech === 'fake') return createFakeVoice(relay, newTurnId);
    return {
      ...browserAdapters(config, relay, studio, () => {
        setBrowserVoiceNotice(true);
      }),
      driver: undefined,
    };
  }, [config, studio]);

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
    studioVoice: studio !== undefined && config.speech === 'browser' && adapters.speaker !== null,
    browserVoiceNotice,
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
