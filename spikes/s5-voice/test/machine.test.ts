import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import { topState, voiceMachine, type VoiceConfig } from '../src/machine';

const config: VoiceConfig = {
  micAvailable: true,
  listenTimeoutMs: 8_000,
  replyTimeoutMs: 5_000,
  speakStartTimeoutMs: 60_000,
  speakTimeoutBaseMs: 4_000,
  speakTimeoutPerCharMs: 80,
};

type Reply = (transcript: string) => Promise<string>;

function start(overrides: Partial<VoiceConfig> = {}, reply: Reply = async () => 'The bedroom stays cool until 7 am.') {
  const calls = {
    startRecognition: vi.fn(),
    stopRecognition: vi.fn(),
    speak: vi.fn<(text: string) => void>(),
    cancelSpeech: vi.fn(),
    reply: vi.fn(reply),
  };
  const machine = voiceMachine.provide({
    actions: {
      startRecognition: calls.startRecognition,
      stopRecognition: calls.stopRecognition,
      speak: ({ context }) => calls.speak(context.reply ?? ''),
      cancelSpeech: calls.cancelSpeech,
    },
    actors: {
      getReply: fromPromise<string, { transcript: string }>(({ input }) => calls.reply(input.transcript)),
    },
  });
  const actor = createActor(machine, { input: { ...config, ...overrides } });
  actor.start();
  return { actor, calls };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('happy path', () => {
  it('goes idle → listening → thinking → speaking → idle', async () => {
    const { actor, calls } = start();
    expect(topState(actor.getSnapshot())).toBe('idle');

    actor.send({ type: 'MIC_PRESSED' });
    expect(topState(actor.getSnapshot())).toBe('listening');
    expect(calls.startRecognition).toHaveBeenCalledOnce();

    actor.send({ type: 'SPEECH_RECOGNISED', transcript: 'how long will the bedroom stay cool' });
    expect(topState(actor.getSnapshot())).toBe('thinking');
    expect(calls.stopRecognition).toHaveBeenCalled();
    expect(calls.reply).toHaveBeenCalledWith('how long will the bedroom stay cool');

    await flush();
    expect(topState(actor.getSnapshot())).toBe('speaking');
    expect(calls.speak).toHaveBeenCalledWith('The bedroom stays cool until 7 am.');

    actor.send({ type: 'SPEAKING_STARTED' });
    expect(topState(actor.getSnapshot())).toBe('speaking');
    actor.send({ type: 'SPEAKING_ENDED' });
    expect(topState(actor.getSnapshot())).toBe('idle');
    expect(actor.getSnapshot().context.reply).toBe('The bedroom stays cool until 7 am.');
    expect(actor.getSnapshot().context.error).toBeNull();
  });

  it('accepts typed text as a first-class input', async () => {
    const { actor, calls } = start();
    actor.send({ type: 'TEXT_SUBMITTED', text: '  status  ' });
    expect(topState(actor.getSnapshot())).toBe('thinking');
    expect(calls.startRecognition).not.toHaveBeenCalled();
    expect(calls.reply).toHaveBeenCalledWith('status');
    await flush();
    expect(topState(actor.getSnapshot())).toBe('speaking');
  });

  it('ignores blank typed text and blank transcripts', () => {
    const { actor } = start();
    actor.send({ type: 'TEXT_SUBMITTED', text: '   ' });
    expect(topState(actor.getSnapshot())).toBe('idle');
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'SPEECH_RECOGNISED', transcript: ' ' });
    expect(topState(actor.getSnapshot())).toBe('listening');
  });
});

describe('forbidden transitions (plan §9.3)', () => {
  it('never speaks while listening', () => {
    const { actor, calls } = start();
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'SPEAKING_STARTED' });
    actor.send({ type: 'SPEAKING_ENDED' });
    expect(topState(actor.getSnapshot())).toBe('listening');
    expect(calls.speak).not.toHaveBeenCalled();
  });

  it('never listens again while the reply is being read', async () => {
    const { actor, calls } = start();
    actor.send({ type: 'TEXT_SUBMITTED', text: 'status' });
    await flush();
    expect(topState(actor.getSnapshot())).toBe('speaking');
    actor.send({ type: 'MIC_PRESSED' });
    expect(topState(actor.getSnapshot())).toBe('speaking');
    expect(calls.startRecognition).not.toHaveBeenCalled();
  });

  it('never listens while thinking and ignores a second input', () => {
    const { actor, calls } = start({}, () => new Promise(() => {}));
    actor.send({ type: 'TEXT_SUBMITTED', text: 'status' });
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'TEXT_SUBMITTED', text: 'again' });
    expect(topState(actor.getSnapshot())).toBe('thinking');
    expect(calls.startRecognition).not.toHaveBeenCalled();
    expect(calls.reply).toHaveBeenCalledOnce();
  });

  it('ignores a late recognition result once back in idle', () => {
    const { actor, calls } = start();
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'CANCEL' });
    actor.send({ type: 'SPEECH_RECOGNISED', transcript: 'late result' });
    expect(topState(actor.getSnapshot())).toBe('idle');
    expect(calls.reply).not.toHaveBeenCalled();
  });

  it('does not open the mic when it is unavailable', () => {
    const { actor, calls } = start({ micAvailable: false });
    actor.send({ type: 'MIC_PRESSED' });
    expect(topState(actor.getSnapshot())).toBe('idle');
    expect(calls.startRecognition).not.toHaveBeenCalled();
  });
});

describe('error paths', () => {
  it('permission denied disables the mic and suggests text', () => {
    const { actor, calls } = start();
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_FAILED', code: 'mic_permission_denied' });
    const snap = actor.getSnapshot();
    expect(topState(snap)).toBe('idle');
    expect(snap.context.error).toBe('mic_permission_denied');
    expect(snap.context.micAvailable).toBe(false);
    expect(snap.context.suggestText).toBe(true);
    actor.send({ type: 'MIC_PRESSED' });
    expect(calls.startRecognition).toHaveBeenCalledOnce();
  });

  it('one retry after a failure, then suggests text', () => {
    const { actor } = start();
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_ENDED' });
    expect(actor.getSnapshot().context.error).toBe('no_speech');
    expect(actor.getSnapshot().context.suggestText).toBe(false);
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_FAILED', code: 'recognition_network' });
    expect(actor.getSnapshot().context.error).toBe('recognition_network');
    expect(actor.getSnapshot().context.suggestText).toBe(true);
  });

  it('a successful turn resets the failure count and clears the error', async () => {
    const { actor } = start();
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_ENDED' });
    actor.send({ type: 'MIC_PRESSED' });
    expect(actor.getSnapshot().context.error).toBeNull();
    actor.send({ type: 'SPEECH_RECOGNISED', transcript: 'status' });
    await flush();
    actor.send({ type: 'SPEAKING_ENDED' });
    expect(actor.getSnapshot().context.failures).toBe(0);
  });

  it('stops listening after the listen timeout', async () => {
    const { actor, calls } = start();
    actor.send({ type: 'MIC_PRESSED' });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(topState(actor.getSnapshot())).toBe('idle');
    expect(actor.getSnapshot().context.error).toBe('listening_timeout');
    expect(calls.stopRecognition).toHaveBeenCalled();
  });

  it('gives up on a slow reply after the reply timeout', async () => {
    const { actor, calls } = start({}, () => new Promise(() => {}));
    actor.send({ type: 'TEXT_SUBMITTED', text: 'status' });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(topState(actor.getSnapshot())).toBe('thinking');
    await vi.advanceTimersByTimeAsync(1);
    expect(topState(actor.getSnapshot())).toBe('idle');
    expect(actor.getSnapshot().context.error).toBe('reply_timeout');
    expect(calls.speak).not.toHaveBeenCalled();
  });

  it('reports a failed reply', async () => {
    const { actor } = start({}, () => Promise.reject(new Error('boom')));
    actor.send({ type: 'TEXT_SUBMITTED', text: 'status' });
    await flush();
    expect(topState(actor.getSnapshot())).toBe('idle');
    expect(actor.getSnapshot().context.error).toBe('reply_failed');
  });

  it('keeps the reply on screen when speech synthesis fails', async () => {
    const { actor } = start();
    actor.send({ type: 'TEXT_SUBMITTED', text: 'status' });
    await flush();
    actor.send({ type: 'SPEAKING_FAILED' });
    const snap = actor.getSnapshot();
    expect(topState(snap)).toBe('idle');
    expect(snap.context.error).toBe('speech_synthesis_failed');
    expect(snap.context.reply).toBe('The bedroom stays cool until 7 am.');
  });

  it('leaves speaking when the end event never arrives (length-based safety timeout)', async () => {
    const { actor, calls } = start();
    actor.send({ type: 'TEXT_SUBMITTED', text: 'status' });
    await flush();
    const reply = 'The bedroom stays cool until 7 am.';
    const limit = config.speakTimeoutBaseMs + config.speakTimeoutPerCharMs * reply.length;
    await vi.advanceTimersByTimeAsync(limit - 1);
    expect(topState(actor.getSnapshot())).toBe('speaking');
    await vi.advanceTimersByTimeAsync(1);
    expect(topState(actor.getSnapshot())).toBe('idle');
    expect(actor.getSnapshot().context.error).toBe('speech_end_missing');
    expect(calls.cancelSpeech).toHaveBeenCalled();
  });

  it('degrades to text when audio never starts (network voice offline hangs silently)', async () => {
    const { actor, calls } = start({ speakStartTimeoutMs: 1_500 });
    actor.send({ type: 'TEXT_SUBMITTED', text: 'status' });
    await flush();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(topState(actor.getSnapshot())).toBe('speaking');
    await vi.advanceTimersByTimeAsync(1);
    const snap = actor.getSnapshot();
    expect(topState(snap)).toBe('idle');
    expect(snap.context.error).toBe('speech_start_missing');
    expect(snap.context.reply).toBe('The bedroom stays cool until 7 am.');
    expect(calls.cancelSpeech).toHaveBeenCalled();
  });

  it('does not apply the start timeout once audio has started', async () => {
    const { actor } = start({ speakStartTimeoutMs: 1_500 });
    actor.send({ type: 'TEXT_SUBMITTED', text: 'status' });
    await flush();
    actor.send({ type: 'SPEAKING_STARTED' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(topState(actor.getSnapshot())).toBe('speaking');
    actor.send({ type: 'SPEAKING_ENDED' });
    expect(actor.getSnapshot().context.error).toBeNull();
  });

  it('cancel stops speech and returns to idle without an error', async () => {
    const { actor, calls } = start();
    actor.send({ type: 'TEXT_SUBMITTED', text: 'status' });
    await flush();
    actor.send({ type: 'CANCEL' });
    expect(topState(actor.getSnapshot())).toBe('idle');
    expect(actor.getSnapshot().context.error).toBeNull();
    expect(calls.cancelSpeech).toHaveBeenCalled();
  });
});
