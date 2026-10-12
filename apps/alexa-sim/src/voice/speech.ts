import { log as defaultLog, type Log } from '../log.js';
import type { ConversationEvent, VoiceErrorCode } from '../machine.js';

// Browser voice (spike S5): Web Speech recognition and synthesis behind two small ports the
// conversation machine drives (startRecognition/stopRecognition, speak/cancelSpeech). The browser
// objects are injected, so the adapters are tested without a browser.

export type Send = (event: ConversationEvent) => void;

export interface Recognizer {
  start(): void;
  stop(): void;
}

export interface Speaker {
  /** `turnId`: the turn's correlation id, for the studio voice's request and logs (the browser voice ignores it). */
  speak(text: string, turnId?: string): void;
  cancel(): void;
}

export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
}

/** Web Speech `error` strings → our codes. `aborted` is our own stop: not an error. */
export function mapRecognitionError(raw: string): VoiceErrorCode | null {
  switch (raw) {
    case 'aborted':
      return null;
    case 'not-allowed':
    case 'service-not-allowed':
      return 'mic_permission_denied';
    case 'no-speech':
      return 'no_speech';
    case 'audio-capture':
      return 'audio_capture_failed';
    case 'network':
      return 'recognition_network';
    case 'language-not-supported':
      return 'language_not_supported';
    default:
      return 'recognition_failed';
  }
}

const normLang = (lang: string) => lang.toLowerCase().replace('_', '-');

/** Network voices sound better but die offline; local ones always work. Exact language, then base. */
export function pickVoice<V extends VoiceInfo>(voices: readonly V[], lang: string, opts: { online: boolean; preferredName?: string }): V | null {
  const usable = voices.filter((v) => opts.online || v.localService);
  const named = opts.preferredName === undefined ? undefined : usable.find((v) => v.name === opts.preferredName);
  if (named) return named;
  const want = normLang(lang);
  const base = want.split('-')[0];
  const rank = (v: V) => (opts.online && v.localService ? 1 : 0);
  const best = (list: V[]) => [...list].sort((a, b) => rank(a) - rank(b))[0];
  return best(usable.filter((v) => normLang(v.lang) === want)) ?? best(usable.filter((v) => normLang(v.lang).split('-')[0] === base)) ?? null;
}

/** The part of SpeechRecognition the adapter uses (TypeScript's DOM lib does not ship it). */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export type RecognitionCtor = new () => RecognitionLike;

/** The browser's recognition constructor, unprefixed (Chrome 153) or webkit-prefixed (Safari), or none. */
export function recognitionCtor(w: object): RecognitionCtor | null {
  const host = w as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

/** One-shot recognition (push to talk): one question, one answer, then the mic closes. */
export function createBrowserRecognizer(ctor: RecognitionCtor, opts: { lang: string; send: Send; newTurnId: () => string; log?: Log }): Recognizer {
  const log = opts.log ?? defaultLog;
  let current: RecognitionLike | null = null;
  return {
    start() {
      const r = new ctor();
      current = r;
      r.lang = opts.lang;
      r.continuous = false;
      r.interimResults = false;
      r.maxAlternatives = 1;
      let settled = false;
      r.onresult = (event) => {
        const result = event.results[event.resultIndex];
        const best = result?.[0];
        if (current !== r || !result?.isFinal || !best) return;
        settled = true;
        opts.send({ type: 'SPEECH_RECOGNISED', transcript: best.transcript, turnId: opts.newTurnId() });
      };
      r.onerror = (event) => {
        const code = mapRecognitionError(event.error);
        if (current !== r || code === null) return;
        settled = true;
        opts.send({ type: 'RECOGNITION_FAILED', code });
      };
      r.onend = () => {
        if (current !== r) return;
        current = null;
        if (!settled) opts.send({ type: 'RECOGNITION_ENDED' });
      };
      try {
        r.start();
      } catch (error) {
        // start() throws when a session is still open: the person can press the mic again (an info line, like every
        // voice failure the UI handles).
        log({ level: 'info', code: 'recognition_failed', error, details: { step: 'start' } });
        current = null;
        opts.send({ type: 'RECOGNITION_FAILED', code: 'recognition_failed' });
      }
    },
    stop() {
      // abort(): drop any pending result; the machine has already moved on.
      const r = current;
      current = null;
      r?.abort();
    },
  };
}

/** The part of SpeechSynthesisUtterance the adapter uses. */
export interface UtteranceLike {
  text: string;
  lang: string;
  voice: VoiceInfo | null;
  volume: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

export interface SynthesisLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  getVoices(): readonly VoiceInfo[];
}

export interface BrowserSpeaker extends Speaker {
  /** A silent utterance at page load: the first speak of a page is the slowest (spike S5, ≈ 840 ms). */
  warmUp(): void;
}

export function createBrowserSpeaker(opts: {
  synth: SynthesisLike;
  utterance: (text: string) => UtteranceLike;
  lang: string;
  /** navigator.onLine: a hint only, spike S5 found it stays true when only the voice service is down. */
  online: () => boolean;
  voiceName?: string;
  send: Send;
}): BrowserSpeaker {
  let current: UtteranceLike | null = null;
  const prepare = (text: string) => {
    const u = opts.utterance(text);
    u.lang = opts.lang;
    u.voice = pickVoice(opts.synth.getVoices(), opts.lang, { online: opts.online(), ...(opts.voiceName !== undefined && { preferredName: opts.voiceName }) });
    return u;
  };
  return {
    speak(text) {
      const u = prepare(text);
      current = u;
      u.onstart = () => {
        if (current === u) opts.send({ type: 'SPEAKING_STARTED' });
      };
      u.onend = () => {
        if (current === u) opts.send({ type: 'SPEAKING_ENDED' });
      };
      u.onerror = (event) => {
        // 'interrupted' and 'canceled' are our own cancel().
        if (current !== u || event.error === 'interrupted' || event.error === 'canceled') return;
        opts.send({ type: 'SPEAKING_FAILED' });
      };
      opts.synth.cancel();
      opts.synth.speak(u);
    },
    cancel() {
      current = null;
      opts.synth.cancel();
    },
    warmUp() {
      const u = prepare(' ');
      u.volume = 0;
      opts.synth.speak(u);
    },
  };
}
