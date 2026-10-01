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
    expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'warn', code: 'recognition_failed', error: expect.any(DOMException) as unknown, details: { step: 'start' } });
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
