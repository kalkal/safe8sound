import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEvent } from '../src/log.js';
import type { ConversationEvent } from '../src/machine.js';
import { createPollySpeaker, type AudioLike, type Synthesize } from '../src/voice/polly-speaker.js';
import type { Speaker } from '../src/voice/speech.js';

// F8d (#25): replies spoken by Amazon Polly, played in the page. Any failure (the studio voice is down,
// slow, refused, or the browser blocks playback) speaks THAT reply with the browser voice instead, with
// one honest notice per page. The answer is never lost and never waits. Fakes only: no Polly, no audio.

class FakeAudio implements AudioLike {
  src = '';
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = true;
  playResult: Promise<void> = Promise.resolve();
  play() {
    this.paused = false;
    return this.playResult;
  }
  pause() {
    this.paused = true;
  }
}

function setup(synthesize: Synthesize, opts: { timeoutMs?: number } = {}) {
  const events: ConversationEvent['type'][] = [];
  const logs: LogEvent[] = [];
  const fallbackSaid: string[] = [];
  const cancelFallback = vi.fn();
  const fallback: Speaker = { speak: (text) => fallbackSaid.push(text), cancel: cancelFallback };
  const audio = new FakeAudio();
  const urls = { made: [] as string[], revoked: [] as string[] };
  const notices: string[] = [];
  const speaker = createPollySpeaker({
    synthesize,
    timeoutMs: opts.timeoutMs ?? 1500,
    audio: () => audio,
    objectUrl: {
      create: () => {
        const url = `blob:fake/${String(urls.made.length + 1)}`;
        urls.made.push(url);
        return url;
      },
      revoke: (url) => urls.revoked.push(url),
    },
    fallback,
    onFallback: () => notices.push('voice.browserVoice'),
    send: (event) => events.push(event.type),
    log: (event) => logs.push(event),
  });
  return { speaker, audio, events, logs, fallbackSaid, cancelFallback, urls, notices };
}

const mp3 = () => Promise.resolve({ ok: true as const, value: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }) });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Tests that need the timeout switch to fake timers; every test ends on the real clock.
afterEach(() => {
  vi.useRealTimers();
});

describe('createPollySpeaker', () => {
  it('plays the studio voice: started when the audio plays, ended when it ends, the object URL freed', async () => {
    const { speaker, audio, events, urls, fallbackSaid } = setup(mp3);
    speaker.speak('Your battery is at 64%.');
    await tick();
    expect(audio.src).toBe('blob:fake/1');
    expect(audio.paused).toBe(false);
    audio.onplaying?.();
    audio.onended?.();
    expect(events).toEqual(['SPEAKING_STARTED', 'SPEAKING_ENDED']);
    expect(urls.revoked).toEqual(['blob:fake/1']);
    expect(fallbackSaid).toEqual([]);
  });

  it.each([
    ['the studio voice is unavailable', () => Promise.resolve({ ok: false as const, code: 'polly_unavailable' as const })],
    ['the request throws (network)', () => Promise.reject(new TypeError('fetch failed'))],
  ])('speaks the same reply with the browser voice when %s, logged without the text', async (_case, synthesize) => {
    const { speaker, events, logs, fallbackSaid, notices } = setup(synthesize);
    speaker.speak('Your battery is at 64%.');
    await tick();
    expect(fallbackSaid).toEqual(['Your battery is at 64%.']);
    expect(notices).toEqual(['voice.browserVoice']);
    expect(events).toEqual([]); // the browser voice sends its own events
    expect(logs).toMatchObject([{ level: 'warn', code: 'polly_unavailable' }]);
    expect(JSON.stringify(logs)).not.toContain('battery');
  });

  it('falls back when the browser refuses to play (autoplay blocked) and frees the URL', async () => {
    const { speaker, audio, fallbackSaid, urls, logs } = setup(mp3);
    audio.playResult = Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    speaker.speak('Hello.');
    await tick();
    await tick();
    expect(fallbackSaid).toEqual(['Hello.']);
    expect(urls.revoked).toEqual(['blob:fake/1']);
    expect(logs[0]).toMatchObject({ code: 'speech_playback_failed', error: expect.objectContaining({ name: 'NotAllowedError' }) as unknown });
  });

  it('falls back once when an undecodable source fires error AND rejects play() (review of #183)', async () => {
    const { speaker, audio, fallbackSaid, logs } = setup(mp3);
    let rejectPlay: (e: Error) => void = () => undefined;
    audio.playResult = new Promise((_resolve, reject) => (rejectPlay = reject));
    speaker.speak('Hello.', 'turn-1');
    await tick();
    audio.onerror?.();
    rejectPlay(Object.assign(new Error('no source'), { name: 'NotSupportedError' }));
    await tick();
    expect(fallbackSaid).toEqual(['Hello.']);
    expect(logs).toHaveLength(1);
  });

  it('carries the turn id: to the studio voice request and to every log line (review of #183)', async () => {
    const asked: (string | undefined)[] = [];
    const { speaker, logs } = setup((_text, _signal, correlationId) => {
      asked.push(correlationId);
      return Promise.resolve({ ok: false as const, code: 'polly_unavailable' as const });
    });
    speaker.speak('Hello.', 'turn-7');
    await tick();
    expect(asked).toEqual(['turn-7']);
    expect(logs).toMatchObject([{ code: 'polly_unavailable', correlationId: 'turn-7' }]);
  });

  it('ignores a studio voice that answers after its timeout: the browser voice already reads the reply', async () => {
    let late: (value: Awaited<ReturnType<Synthesize>>) => void = () => undefined;
    // Fake timers: the timeout fires when the test says so, never by the wall clock (no race under load).
    vi.useFakeTimers();
    const { speaker, audio, fallbackSaid, events } = setup(() => new Promise((resolve) => (late = resolve)), { timeoutMs: 10 });
    speaker.speak('Hello.');
    await vi.advanceTimersByTimeAsync(10);
    late({ ok: true, value: new Blob([new Uint8Array([1])]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(fallbackSaid).toEqual(['Hello.']);
    expect(audio.src).toBe('');
    expect(events).toEqual([]);
  });

  it('falls back when the audio cannot be decoded (an error before it plays)', async () => {
    const { speaker, audio, fallbackSaid } = setup(mp3);
    speaker.speak('Hello.');
    await tick();
    audio.onerror?.();
    expect(fallbackSaid).toEqual(['Hello.']);
  });

  it('does not wait for a slow studio voice: after its own timeout it aborts and uses the browser voice', async () => {
    let aborted = false;
    const slow: Synthesize = (_text, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    vi.useFakeTimers();
    const { speaker, fallbackSaid, logs } = setup(slow, { timeoutMs: 20 });
    speaker.speak('Hello.');
    await vi.advanceTimersByTimeAsync(19);
    expect(fallbackSaid).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    expect(fallbackSaid).toEqual(['Hello.']);
    expect(logs[0]).toMatchObject({ code: 'speech_timeout' });
  });

  it('uses the browser voice quietly when the sim-api offered no studio voice for this reply (speech off): no notice, no log', async () => {
    const { speaker, fallbackSaid, notices, logs } = setup(() => Promise.resolve({ ok: false as const, code: 'not_offered' as const }));
    speaker.speak('Hello.');
    await tick();
    expect(fallbackSaid).toEqual(['Hello.']);
    expect(notices).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('shows the notice once per page, however many replies fall back', async () => {
    const { speaker, notices, fallbackSaid } = setup(() => Promise.resolve({ ok: false as const, code: 'polly_unavailable' as const }));
    speaker.speak('One.');
    await tick();
    speaker.speak('Two.');
    await tick();
    expect(fallbackSaid).toEqual(['One.', 'Two.']);
    expect(notices).toHaveLength(1);
  });

  it('cancel stops everything: a late answer never plays, the audio pauses, the browser voice is cancelled too', async () => {
    let resolveLate: (value: Awaited<ReturnType<Synthesize>>) => void = () => undefined;
    const { speaker, audio, events, cancelFallback, fallbackSaid } = setup(() => new Promise((resolve) => (resolveLate = resolve)));
    speaker.speak('Hello.');
    speaker.cancel();
    resolveLate({ ok: true, value: new Blob([]) });
    await tick();
    expect(audio.src).toBe('');
    expect(audio.paused).toBe(true);
    expect(events).toEqual([]);
    expect(fallbackSaid).toEqual([]);
    expect(cancelFallback).toHaveBeenCalled();
  });

  it('a new reply replaces the one still playing: the old one sends no more events', async () => {
    const { speaker, audio, events } = setup(mp3);
    speaker.speak('First.');
    await tick();
    const first = { onended: audio.onended };
    speaker.speak('Second.');
    await tick();
    first.onended?.();
    expect(events).toEqual([]);
    audio.onplaying?.();
    expect(events).toEqual(['SPEAKING_STARTED']);
  });
});
