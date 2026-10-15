import { describe, expect, it, vi } from 'vitest';
import type { ConversationEvent } from '../src/machine.js';
import {
  createBrowserRecognizer,
  createBrowserSpeaker,
  mapRecognitionError,
  pickVoice,
  type RecognitionLike,
  type SynthesisLike,
  type UtteranceLike,
  type VoiceInfo,
} from '../src/voice/speech.js';

// Browser voice adapters (spike S5): Web Speech recognition and synthesis behind two small ports.
// The browser objects are injected, so these tests drive their callbacks directly.

describe('mapRecognitionError', () => {
  it.each([
    ['not-allowed', 'mic_permission_denied'],
    ['service-not-allowed', 'mic_permission_denied'],
    ['no-speech', 'no_speech'],
    ['audio-capture', 'audio_capture_failed'],
    ['network', 'recognition_network'],
    ['language-not-supported', 'language_not_supported'],
    ['something-new', 'recognition_failed'],
  ])('%s → %s', (raw, code) => {
    expect(mapRecognitionError(raw)).toBe(code);
  });

  it('treats "aborted" as our own stop, not an error', () => {
    expect(mapRecognitionError('aborted')).toBeNull();
  });
});

describe('pickVoice', () => {
  const voices: VoiceInfo[] = [
    { name: 'Italian', lang: 'it-IT', localService: true },
    { name: 'Google US English', lang: 'en-US', localService: false },
    { name: 'Local US', lang: 'en-US', localService: true },
    { name: 'Google UK', lang: 'en-GB', localService: false },
  ];

  it('prefers a network voice in the exact language when online, local ones offline', () => {
    expect(pickVoice(voices, 'en-US', { online: true })?.name).toBe('Google US English');
    expect(pickVoice(voices, 'en-US', { online: false })?.name).toBe('Local US');
  });

  it('falls back to the same base language, honours a configured name, and finds nothing else', () => {
    expect(pickVoice(voices.filter((v) => v.lang !== 'en-US'), 'en-US', { online: true })?.name).toBe('Google UK');
    expect(pickVoice(voices, 'en-US', { online: true, preferredName: 'Local US' })?.name).toBe('Local US');
    expect(pickVoice([voices[0] as VoiceInfo], 'en-US', { online: true })).toBeNull();
  });
});

class FakeRecognition implements RecognitionLike {
  static last: FakeRecognition | undefined;
  lang = '';
  continuous = true;
  interimResults = true;
  maxAlternatives = 5;
  onresult: RecognitionLike['onresult'] = null;
  onerror: RecognitionLike['onerror'] = null;
  onend: RecognitionLike['onend'] = null;
  start = vi.fn();
  abort = vi.fn();
  constructor() {
    FakeRecognition.last = this;
  }
  result(transcript: string, isFinal = true) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript, confidence: 0.9 }], { isFinal })] });
  }
}

function recognizer() {
  const events: ConversationEvent[] = [];
  const rec = createBrowserRecognizer(FakeRecognition, { lang: 'en-US', send: (e) => events.push(e), newTurnId: () => 'v1' });
  rec.start();
  const current = FakeRecognition.last;
  if (!current) throw new Error('no recognition');
  return { rec, current, events };
}

describe('createBrowserRecognizer', () => {
  it('listens one shot, in the configured language, and sends the final transcript with a new turn id', () => {
    const { current, events } = recognizer();
    expect(current).toMatchObject({ lang: 'en-US', continuous: false, interimResults: false, maxAlternatives: 1 });
    expect(current.start).toHaveBeenCalledOnce();
    current.result('battery', false);
    current.result('battery level');
    current.onend?.();
    expect(events).toEqual([{ type: 'SPEECH_RECOGNISED', transcript: 'battery level', turnId: 'v1' }]);
  });

  it('reports an end without words and a mapped error, but not our own abort', () => {
    const silent = recognizer();
    silent.current.onend?.();
    expect(silent.events).toEqual([{ type: 'RECOGNITION_ENDED' }]);
    const failing = recognizer();
    failing.current.onerror?.({ error: 'not-allowed' });
    failing.current.onend?.();
    expect(failing.events).toEqual([{ type: 'RECOGNITION_FAILED', code: 'mic_permission_denied' }]);
    const aborted = recognizer();
    aborted.current.onerror?.({ error: 'aborted' });
    expect(aborted.events).toEqual([]);
  });

  it('stop() aborts and drops anything that arrives later', () => {
    const { rec, current, events } = recognizer();
    rec.stop();
    expect(current.abort).toHaveBeenCalledOnce();
    current.result('too late');
    current.onend?.();
    expect(events).toEqual([]);
  });

  it('turns a throwing start() into a recognition failure', () => {
    const events: ConversationEvent[] = [];
    class Broken extends FakeRecognition {
      override start = vi.fn(() => {
        throw new DOMException('busy', 'InvalidStateError');
      });
    }
    const log = vi.fn();
    createBrowserRecognizer(Broken, { lang: 'en-US', send: (e) => events.push(e), newTurnId: () => 'v1', log }).start();
    expect(events).toEqual([{ type: 'RECOGNITION_FAILED', code: 'recognition_failed' }]);
    expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'info', code: 'recognition_failed', error: expect.any(DOMException) as unknown, details: { step: 'start' } });
  });
});

function speaker() {
  const events: ConversationEvent[] = [];
  const spoken: UtteranceLike[] = [];
  const synth: SynthesisLike = {
    speak: vi.fn((u: UtteranceLike) => spoken.push(u)),
    cancel: vi.fn(),
    getVoices: () => [{ name: 'Google US English', lang: 'en-US', localService: false }],
  };
  const sp = createBrowserSpeaker({
    synth,
    utterance: (text) => ({ text, lang: '', voice: null, volume: 1, onstart: null, onend: null, onerror: null }),
    lang: 'en-US',
    online: () => true,
    send: (e) => events.push(e),
  });
  return { sp, synth, spoken, events };
}

describe('createBrowserSpeaker', () => {
  it('speaks in the configured language with the chosen voice and reports start and end', () => {
    const { sp, spoken, events } = speaker();
    sp.speak('Your battery is at 78 percent.');
    const u = spoken[0];
    expect(u).toMatchObject({ text: 'Your battery is at 78 percent.', lang: 'en-US', voice: { name: 'Google US English' } });
    u?.onstart?.();
    u?.onend?.();
    expect(events).toEqual([{ type: 'SPEAKING_STARTED' }, { type: 'SPEAKING_ENDED' }]);
  });

  it('reports a real synthesis error, but not our own cancel', () => {
    const { sp, spoken, events } = speaker();
    sp.speak('Hi.');
    spoken[0]?.onerror?.({ error: 'synthesis-failed' });
    expect(events).toEqual([{ type: 'SPEAKING_FAILED' }]);
    const other = speaker();
    other.sp.speak('Hi.');
    other.sp.cancel();
    other.spoken[0]?.onerror?.({ error: 'interrupted' });
    other.spoken[0]?.onend?.();
    expect(other.events).toEqual([]);
  });

  it('warms up with a silent utterance that reports nothing (the first speak is the slowest, spike S5)', () => {
    const { sp, spoken, events } = speaker();
    sp.warmUp();
    expect(spoken[0]).toMatchObject({ volume: 0 });
    spoken[0]?.onstart?.();
    spoken[0]?.onend?.();
    expect(events).toEqual([]);
  });
});

describe('createBrowserSpeaker on a phone (Chrome for Android)', () => {
  function phone(opts: { voices?: VoiceInfo[]; speaking?: boolean } = {}) {
    const events: ConversationEvent[] = [];
    const spoken: UtteranceLike[] = [];
    const listeners: (() => void)[] = [];
    const timers: { run: () => void; ms: number; live: boolean }[] = [];
    let voices = opts.voices ?? [];
    const speakSpy = vi.fn((u: UtteranceLike) => spoken.push(u));
    const cancelSpy = vi.fn();
    const synth: SynthesisLike = {
      speak: speakSpy,
      cancel: cancelSpy,
      getVoices: () => voices,
      addEventListener: (_t, l) => listeners.push(l),
      removeEventListener: (_t, l) => listeners.splice(listeners.indexOf(l), 1),
      speaking: opts.speaking ?? false,
      pending: false,
    };
    const log = vi.fn();
    const sp = createBrowserSpeaker({
      synth,
      utterance: (text) => ({ text, lang: '', voice: null, volume: 1, onstart: null, onend: null, onerror: null }),
      lang: 'it-IT',
      online: () => true,
      send: (e) => events.push(e),
      log,
      timers: {
        set: (run, ms) => {
          const t = { run, ms, live: true };
          timers.push(t);
          return t;
        },
        clear: (h) => {
          (h as { live: boolean }).live = false;
        },
      },
    });
    return { sp, synth, speakSpy, cancelSpy, spoken, events, log, listeners, timers, setVoices: (v: VoiceInfo[]) => (voices = v) };
  }
  const italian: VoiceInfo = { name: 'it', lang: 'it-IT', localService: true };

  it('unlock() speaks one silent utterance synchronously, inside the tap', () => {
    const { sp, spoken, events } = phone({ voices: [italian] });
    sp.unlock();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ volume: 0 });
    expect(events).toEqual([]);
  });

  it('waits for the voice list (empty at first) and then speaks with the right voice', () => {
    const { sp, spoken, listeners, setVoices, speakSpy } = phone();
    sp.speak('Ciao.');
    expect(speakSpy).not.toHaveBeenCalled();
    setVoices([italian]);
    listeners[0]?.();
    expect(spoken[0]).toMatchObject({ text: 'Ciao.', voice: { name: 'it' } });
  });

  it('speaks anyway when the voice list never arrives', () => {
    const { sp, spoken, timers } = phone();
    sp.speak('Ciao.');
    timers.find((t) => t.ms === 1000)?.run();
    expect(spoken).toHaveLength(1);
  });

  it('does not cancel an idle synthesis before speaking (it drops the new utterance on Android)', () => {
    const idle = phone({ voices: [italian], speaking: false });
    idle.sp.speak('Ciao.');
    expect(idle.cancelSpy).not.toHaveBeenCalled();
  });

  it('logs a structured warning with the turn id when the browser refuses (not-allowed)', () => {
    const { sp, spoken, events, log } = phone({ voices: [italian] });
    sp.speak('Ciao.', 'turn-1');
    spoken[0]?.onerror?.({ error: 'not-allowed' });
    expect(events).toEqual([{ type: 'SPEAKING_FAILED' }]);
    expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'warn', code: 'speech_blocked', correlationId: 'turn-1', details: { reason: 'not-allowed' } });
  });

  it('logs when nothing starts within 1.5 s, and not when it did start', () => {
    const silent = phone({ voices: [italian] });
    silent.sp.speak('Ciao.', 'turn-2');
    silent.timers.find((t) => t.ms === 1500)?.run();
    expect(silent.log).toHaveBeenCalledExactlyOnceWith({ level: 'warn', code: 'speech_blocked', correlationId: 'turn-2', details: { reason: 'no_start' } });
    const fine = phone({ voices: [italian] });
    fine.sp.speak('Ciao.', 'turn-3');
    fine.spoken[0]?.onstart?.();
    expect(fine.timers.find((t) => t.ms === 1500)?.live).toBe(false);
    expect(fine.log).not.toHaveBeenCalled();
  });

  it('queues behind the silent unlock phrase and cancels only one of its own real phrases', () => {
    const t = phone({ voices: [italian], speaking: true });
    t.sp.unlock();
    t.sp.speak('Uno.');
    expect(t.cancelSpy).not.toHaveBeenCalled();
    t.sp.speak('Due.');
    expect(t.cancelSpy).toHaveBeenCalledOnce();
  });

  it('replay speaks inside the tap even when the voice list is empty, and calls done once when over', () => {
    const t = phone();
    const done = vi.fn();
    t.sp.replay('Ciao.', done);
    expect(t.spoken).toHaveLength(1);
    expect(t.cancelSpy).not.toHaveBeenCalled();
    t.spoken[0]?.onend?.();
    t.spoken[0]?.onerror?.({ error: 'interrupted' });
    expect(done).toHaveBeenCalledOnce();
  });
});
