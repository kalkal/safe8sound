import { log as defaultLog, type Log } from '../log.js';
import type { Send, Speaker } from './speech.js';

/**
 * What the page needs to fetch one spoken reply: the mp3, or why not. `not_offered`: the sim-api gave this
 * reply no studio voice (speech switched off), so the browser voice reads it quietly. Never the text in an error.
 */
export type Synthesize = (text: string, signal: AbortSignal, correlationId?: string) => Promise<{ ok: true; value: Blob } | { ok: false; code: 'polly_unavailable' | 'not_offered' }>;

/** The part of HTMLAudioElement the speaker uses. */
export interface AudioLike {
  src: string;
  onplaying: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
}

/**
 * Replies in the studio voice (F8d, #25, approved in #25): Amazon Polly through the sim-api, played in the
 * page. Any failure (unavailable, slower than `timeoutMs`, refused, not decodable, playback blocked) speaks
 * THAT reply with the browser voice instead, so the answer is never lost and never waits; the first time,
 * `onFallback` shows one honest notice. Logs carry the code only, never the text.
 */
export function createPollySpeaker(opts: {
  synthesize: Synthesize;
  /** Below the machine's speak-start timeout, so the browser voice still starts in time. */
  timeoutMs: number;
  audio: () => AudioLike;
  objectUrl: { create(blob: Blob): string; revoke(url: string): void };
  fallback: Speaker;
  onFallback: () => void;
  send: Send;
  log?: Log;
}): Speaker {
  const log = opts.log ?? defaultLog;
  const audio = opts.audio();
  let generation = 0;
  let controller: AbortController | null = null;
  let url: string | null = null;
  let noticeShown = false;

  const freeUrl = () => {
    if (url !== null) opts.objectUrl.revoke(url);
    url = null;
  };
  const stopAudio = () => {
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    freeUrl();
  };
  const fallBack = (text: string, code: string, turnId: string | undefined, error?: unknown) => {
    log({ level: 'warn', code, ...(turnId === undefined ? {} : { correlationId: turnId }), ...(error === undefined ? {} : { error }) });
    stopAudio();
    if (!noticeShown) {
      noticeShown = true;
      opts.onFallback();
    }
    opts.fallback.speak(text, turnId);
  };

  return {
    speak(text, turnId) {
      const mine = ++generation;
      controller?.abort();
      stopAudio();
      const abort = new AbortController();
      controller = abort;
      // One attempt falls back at most once: an undecodable source fires `error` AND rejects play() (review of #183).
      let settled = false;
      const current = () => mine === generation && !settled;
      const failOnce = (code: string, error?: unknown) => {
        settled = true;
        fallBack(text, code, turnId, error);
      };
      // At the timeout the browser voice reads the reply at once, whether or not the request honours the abort;
      // a late answer then finds the attempt settled and is ignored.
      const timer = setTimeout(() => {
        abort.abort();
        if (current()) failOnce('speech_timeout');
      }, opts.timeoutMs);

      void opts
        .synthesize(text, abort.signal, turnId)
        .then(
          (result) => {
            clearTimeout(timer);
            if (!current()) return;
            if (!result.ok && result.code === 'not_offered') {
              settled = true;
              opts.fallback.speak(text, turnId);
              return;
            }
            if (!result.ok) {
              failOnce(result.code);
              return;
            }
            url = opts.objectUrl.create(result.value);
            audio.onplaying = () => {
              if (current()) opts.send({ type: 'SPEAKING_STARTED' });
            };
            audio.onended = () => {
              if (!current()) return;
              freeUrl();
              opts.send({ type: 'SPEAKING_ENDED' });
            };
            audio.onerror = () => {
              if (current()) failOnce('speech_playback_failed');
            };
            audio.src = url;
            audio.play().catch((error: unknown) => {
              // NotAllowedError: the browser blocked autoplay; the browser voice is not blocked the same way.
              if (current()) failOnce('speech_playback_failed', error);
            });
          },
          (error: unknown) => {
            clearTimeout(timer);
            // A timeout has already settled the attempt in the timer; this is a real failure of the request.
            if (current()) failOnce('polly_unavailable', error);
          },
        );
    },
    cancel() {
      generation++;
      controller?.abort();
      controller = null;
      stopAudio();
      audio.src = '';
      opts.fallback.cancel();
    },
  };
}
