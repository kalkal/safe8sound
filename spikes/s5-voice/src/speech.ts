import type { VoiceErrorCode, VoiceEvent } from './machine';
import type { TurnMark } from './latency';

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

const normLang = (l: string) => l.toLowerCase().replace('_', '-');

/**
 * Network voices (e.g. "Google US English") sound better but die offline;
 * local OS voices always work. Exact language first, then the base language.
 */
export function pickVoice<V extends VoiceInfo>(
  voices: readonly V[],
  lang: string,
  opts: { online: boolean; preferredName?: string },
): V | null {
  const usable = voices.filter((v) => opts.online || v.localService);
  if (opts.preferredName) {
    const named = usable.find((v) => v.name === opts.preferredName);
    if (named) return named;
  }
  const want = normLang(lang);
  const base = want.split('-')[0];
  const rank = (v: V) => (opts.online ? (v.localService ? 1 : 0) : 0);
  const byRank = (xs: V[]) => [...xs].sort((a, b) => rank(a) - rank(b));
  const exact = byRank(usable.filter((v) => normLang(v.lang) === want));
  if (exact[0]) return exact[0];
  const sameBase = byRank(usable.filter((v) => normLang(v.lang).split('-')[0] === base));
  return sameBase[0] ?? null;
}

export type Send = (event: VoiceEvent) => void;
export type Mark = (mark: TurnMark) => void;

export interface Recognizer {
  start(): void;
  stop(): void;
}

export interface Synthesizer {
  speak(text: string): void;
  cancel(): void;
}

export function getRecognitionCtor(w: Window = window): SpeechRecognitionConstructor | null {
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** One-shot recognition (continuous = false): one question, one answer, then the mic closes. */
export function createBrowserRecognizer(
  ctor: SpeechRecognitionConstructor,
  opts: {
    lang: string;
    processLocally: boolean;
    send: Send;
    mark: Mark;
    log: (msg: string) => void;
    /** Chrome 13x+: `start(track)` recognises any MediaStreamTrack instead of the system mic. */
    getTrack?: () => Promise<MediaStreamTrack>;
  },
): Recognizer {
  let current: SpeechRecognition | null = null;
  let openTrack: MediaStreamTrack | null = null;
  const releaseTrack = () => {
    openTrack?.stop();
    openTrack = null;
  };
  return {
    start() {
      const r = new ctor();
      current = r;
      r.lang = opts.lang;
      r.continuous = false;
      r.interimResults = false;
      r.maxAlternatives = 1;
      if (opts.processLocally) r.processLocally = true;
      let gotResult = false;
      let failed = false;
      r.onaudiostart = () => opts.log('audiostart');
      r.onspeechend = () => opts.mark('speechEnd');
      r.onresult = (e) => {
        const result = e.results[e.resultIndex];
        const alt = result?.[0];
        if (!result?.isFinal || !alt) return;
        gotResult = true;
        opts.mark('recognised');
        opts.log(`result "${alt.transcript}" confidence ${alt.confidence.toFixed(2)}`);
        opts.send({ type: 'SPEECH_RECOGNISED', transcript: alt.transcript });
      };
      r.onerror = (e) => {
        opts.log(`recognition error "${e.error}" ${e.message}`);
        const code = mapRecognitionError(e.error);
        if (code === null) return;
        failed = true;
        opts.send({ type: 'RECOGNITION_FAILED', code });
      };
      r.onend = () => {
        releaseTrack();
        if (current === r) current = null;
        if (!gotResult && !failed) opts.send({ type: 'RECOGNITION_ENDED' });
      };
      if (!opts.getTrack) {
        r.start();
        return;
      }
      opts
        .getTrack()
        .then((track) => {
          if (current !== r) return track.stop();
          openTrack = track;
          r.start(track);
        })
        .catch((err: unknown) => {
          opts.log(`getUserMedia failed: ${String(err)}`);
          if (current !== r) return;
          const denied = err instanceof DOMException && err.name === 'NotAllowedError';
          opts.send({ type: 'RECOGNITION_FAILED', code: denied ? 'mic_permission_denied' : 'audio_capture_failed' });
        });
    },
    stop() {
      // abort(): drop any pending result; the machine has already moved on.
      const r = current;
      current = null;
      releaseTrack();
      if (r) {
        r.onend = null;
        r.abort();
      }
    },
  };
}

export function createBrowserSynthesizer(opts: {
  lang: string;
  voice: () => SpeechSynthesisVoice | null;
  send: Send;
  mark: Mark;
  log: (msg: string) => void;
}): Synthesizer {
  let current: SpeechSynthesisUtterance | null = null;
  return {
    speak(text) {
      const u = new SpeechSynthesisUtterance(text);
      current = u;
      u.lang = opts.lang;
      const v = opts.voice();
      if (v) u.voice = v;
      u.onstart = () => {
        opts.mark('audioStart');
        opts.send({ type: 'SPEAKING_STARTED' });
      };
      u.onend = () => {
        if (current !== u) return;
        opts.mark('audioEnd');
        opts.send({ type: 'SPEAKING_ENDED' });
      };
      u.onerror = (e) => {
        if (current !== u) return;
        opts.log(`synthesis error "${e.error}"`);
        // 'interrupted' / 'canceled' are our own cancel().
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        opts.send({ type: 'SPEAKING_FAILED' });
      };
      opts.log(`speak with voice "${v?.name ?? 'default'}" (${v ? (v.localService ? 'local' : 'network') : '?'})`);
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    },
    cancel() {
      current = null;
      speechSynthesis.cancel();
    },
  };
}

/** Fakes for the E2E test: the test drives them through `window.__voiceTest`. */
export function createFakeRecognizer(): Recognizer & { active: () => boolean } {
  let active = false;
  return {
    start: () => {
      active = true;
    },
    stop: () => {
      active = false;
    },
    active: () => active,
  };
}

/** `silent` imitates a network voice offline: no start, no end, no error. */
export function createFakeSynthesizer(opts: { send: Send; mark: Mark; durationMs: number; autoFinish: boolean; silent: boolean }): Synthesizer & {
  speaking: () => boolean;
  lastText: () => string | null;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let speaking = false;
  let last: string | null = null;
  return {
    speak(text) {
      last = text;
      speaking = true;
      if (opts.silent) return;
      queueMicrotask(() => {
        if (!speaking) return;
        opts.mark('audioStart');
        opts.send({ type: 'SPEAKING_STARTED' });
      });
      if (opts.autoFinish) {
        timer = setTimeout(() => {
          speaking = false;
          opts.mark('audioEnd');
          opts.send({ type: 'SPEAKING_ENDED' });
        }, opts.durationMs);
      }
    },
    cancel() {
      speaking = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    speaking: () => speaking,
    lastText: () => last,
  };
}
