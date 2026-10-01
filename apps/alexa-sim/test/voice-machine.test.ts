import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import { conversationMachine, topState, type AskInput, type AskOutput, type VoiceFailure, type VoiceSettings } from '../src/machine.js';

// The voice round trip of F8d (#25, plan §9.3, spike S5): idle → listening → thinking → speaking →
// showingAnswer. Forbidden by construction: speaking while listening, listening while speaking.

type Outcome = Result<AskOutput, ErrorEnvelope>;

const VOICE: VoiceSettings = {
  micAvailable: true,
  speakReplies: true,
  listenTimeoutMs: 1_000,
  speakStartTimeoutMs: 1_000,
  speakTimeoutBaseMs: 1_000,
  speakTimeoutPerCharMs: 0,
};

function start(ask: (input: AskInput) => Promise<Outcome>, voice: Partial<VoiceSettings> = {}) {
  const effects = {
    startRecognition: vi.fn(),
    stopRecognition: vi.fn(),
    speak: vi.fn<(text: string) => void>(),
    cancelSpeech: vi.fn(),
    logVoiceFailure: vi.fn<(failure: VoiceFailure) => void>(),
  };
  const machine = conversationMachine.provide({
    actors: { askAgent: fromPromise<Outcome, AskInput>(({ input }) => ask(input)) },
    actions: {
      startRecognition: effects.startRecognition,
      stopRecognition: effects.stopRecognition,
      speak: ({ context }) => {
        effects.speak(context.speech ?? '');
      },
      cancelSpeech: effects.cancelSpeech,
      logVoiceFailure: (_, failure: VoiceFailure) => {
        effects.logVoiceFailure(failure);
      },
    },
  });
  const actor = createActor(machine, { input: { replyTimeoutMs: 1_000, voice: { ...VOICE, ...voice } } });
  actor.start();
  return { actor, effects };
}

const never = () => new Promise<Outcome>(() => undefined);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const answer = (speech: string) => () => Promise.resolve(ok({ speech }));
const heard = (transcript: string, turnId = 'v1') => ({ type: 'SPEECH_RECOGNISED' as const, transcript, turnId });

describe('voice: listening', () => {
  it('starts listening on the mic and stops recognition when it leaves', () => {
    const { actor, effects } = start(never);
    actor.send({ type: 'MIC_PRESSED' });
    expect(topState(actor.getSnapshot())).toBe('listening');
    expect(effects.startRecognition).toHaveBeenCalledOnce();
    actor.send({ type: 'CANCEL' });
    expect(topState(actor.getSnapshot())).toBe('idle');
    expect(effects.stopRecognition).toHaveBeenCalledOnce();
  });

  it('asks with the recognised words and the turn id', async () => {
    const asked: AskInput[] = [];
    const { actor } = start((input) => {
      asked.push(input);
      return Promise.resolve(ok({}));
    });
    actor.send({ type: 'MIC_PRESSED' });
    actor.send(heard("  what's my battery level  ", 'v7'));
    expect(topState(actor.getSnapshot())).toBe('thinking');
    await settle();
    expect(asked).toEqual([{ question: "what's my battery level", turnId: 'v7' }]);
  });

  it('ignores the mic when there is none, and an empty transcript', () => {
    const { actor } = start(never, { micAvailable: false });
    actor.send({ type: 'MIC_PRESSED' });
    expect(topState(actor.getSnapshot())).toBe('idle');
    const other = start(never).actor;
    other.send({ type: 'MIC_PRESSED' });
    other.send(heard('   '));
    expect(topState(other.getSnapshot())).toBe('listening');
  });

  it('ignores a late recognition result after cancel', () => {
    const { actor } = start(never);
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'CANCEL' });
    actor.send(heard('too late'));
    expect(topState(actor.getSnapshot())).toBe('idle');
  });

  it('reprompts once after a failure, then suggests typing (plan §11.2 p.10)', () => {
    const { actor } = start(never);
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_ENDED' });
    expect(actor.getSnapshot().context).toMatchObject({ voiceError: 'no_speech', suggestText: false });
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_FAILED', code: 'recognition_network' });
    expect(actor.getSnapshot().context).toMatchObject({ voiceError: 'recognition_network', suggestText: true });
  });

  it('turns the mic off for good when permission is denied', () => {
    const { actor } = start(never);
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_FAILED', code: 'mic_permission_denied' });
    expect(actor.getSnapshot().context).toMatchObject({ micAvailable: false, suggestText: true });
    actor.send({ type: 'MIC_PRESSED' });
    expect(topState(actor.getSnapshot())).toBe('idle');
  });

  it('gives up listening after the listen timeout', async () => {
    const { actor } = start(never, { listenTimeoutMs: 5 });
    actor.send({ type: 'MIC_PRESSED' });
    await wait(30);
    expect(topState(actor.getSnapshot())).toBe('idle');
    expect(actor.getSnapshot().context.voiceError).toBe('listening_timeout');
  });

  it('is never entered from thinking or speaking (no re-listening while answering)', async () => {
    const { actor, effects } = start(answer('Your battery is at 78 percent.'));
    actor.send({ type: 'TEXT_SUBMITTED', text: 'q', turnId: 't1' });
    actor.send({ type: 'MIC_PRESSED' });
    expect(topState(actor.getSnapshot())).toBe('thinking');
    await settle();
    expect(topState(actor.getSnapshot())).toBe('speaking');
    actor.send({ type: 'MIC_PRESSED' });
    expect(topState(actor.getSnapshot())).toBe('speaking');
    expect(effects.startRecognition).not.toHaveBeenCalled();
  });
});

describe('voice: speaking', () => {
  it('speaks the reply, then shows the answer; the answer is on screen while it speaks', async () => {
    const { actor, effects } = start(answer('Your battery is at 78 percent.'));
    actor.send({ type: 'TEXT_SUBMITTED', text: 'q', turnId: 't1' });
    await settle();
    expect(actor.getSnapshot().matches({ speaking: 'waitingForAudio' })).toBe(true);
    expect(effects.speak).toHaveBeenCalledExactlyOnceWith('Your battery is at 78 percent.');
    actor.send({ type: 'SPEAKING_STARTED' });
    expect(actor.getSnapshot().matches({ speaking: 'audible' })).toBe(true);
    actor.send({ type: 'SPEAKING_ENDED' });
    expect(topState(actor.getSnapshot())).toBe('showingAnswer');
  });

  it('shows the answer without speaking when replies are not spoken or there is nothing to say', async () => {
    const silent = start(answer('Hi.'), { speakReplies: false });
    silent.actor.send({ type: 'TEXT_SUBMITTED', text: 'q', turnId: 't1' });
    await settle();
    expect(topState(silent.actor.getSnapshot())).toBe('showingAnswer');
    expect(silent.effects.speak).not.toHaveBeenCalled();
    const empty = start(() => Promise.resolve(ok({})));
    empty.actor.send({ type: 'TEXT_SUBMITTED', text: 'q', turnId: 't1' });
    await settle();
    expect(topState(empty.actor.getSnapshot())).toBe('showingAnswer');
  });

  it('keeps the answer on screen when the audio never starts (a network voice offline hangs)', async () => {
    const { actor, effects } = start(answer('Hi.'), { speakStartTimeoutMs: 5 });
    actor.send({ type: 'TEXT_SUBMITTED', text: 'q', turnId: 't1' });
    await wait(30);
    expect(topState(actor.getSnapshot())).toBe('showingAnswer');
    expect(actor.getSnapshot().context.voiceError).toBe('speech_start_missing');
    expect(effects.cancelSpeech).toHaveBeenCalled();
  });

  it('keeps the answer on screen when the synthesis fails or never ends', async () => {
    const failed = start(answer('Hi.'));
    failed.actor.send({ type: 'TEXT_SUBMITTED', text: 'q', turnId: 't1' });
    await settle();
    failed.actor.send({ type: 'SPEAKING_FAILED' });
    expect(topState(failed.actor.getSnapshot())).toBe('showingAnswer');
    expect(failed.actor.getSnapshot().context.voiceError).toBe('speech_synthesis_failed');

    const hung = start(answer('Hi.'), { speakTimeoutBaseMs: 5 });
    hung.actor.send({ type: 'TEXT_SUBMITTED', text: 'q', turnId: 't1' });
    await settle();
    hung.actor.send({ type: 'SPEAKING_STARTED' });
    await wait(30);
    expect(topState(hung.actor.getSnapshot())).toBe('showingAnswer');
    expect(hung.actor.getSnapshot().context.voiceError).toBe('speech_end_missing');
  });

  it('stops the voice on CANCEL and on a new question', async () => {
    const { actor, effects } = start(answer('Hi.'));
    actor.send({ type: 'TEXT_SUBMITTED', text: 'q', turnId: 't1' });
    await settle();
    actor.send({ type: 'CANCEL' });
    expect(topState(actor.getSnapshot())).toBe('showingAnswer');
    expect(effects.cancelSpeech).toHaveBeenCalledOnce();
    actor.send({ type: 'TEXT_SUBMITTED', text: 'again', turnId: 't2' });
    await settle();
    actor.send({ type: 'TEXT_SUBMITTED', text: 'third', turnId: 't3' });
    expect(topState(actor.getSnapshot())).toBe('thinking');
    expect(effects.cancelSpeech).toHaveBeenCalledTimes(2);
  });

  it('clears the reprompt after a full voice turn', async () => {
    const { actor } = start(answer('Hi.'));
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_ENDED' });
    actor.send({ type: 'MIC_PRESSED' });
    actor.send(heard('battery'));
    await settle();
    actor.send({ type: 'SPEAKING_STARTED' });
    actor.send({ type: 'SPEAKING_ENDED' });
    expect(actor.getSnapshot().context).toMatchObject({ voiceFailures: 0, voiceError: null, suggestText: false });
  });

  it('still fails a turn the agent could not answer, without speaking', async () => {
    const { actor, effects } = start(() => Promise.resolve(err(toolError('agent_unavailable', 'Unreachable.'))));
    actor.send({ type: 'MIC_PRESSED' });
    actor.send(heard('battery'));
    await settle();
    expect(topState(actor.getSnapshot())).toBe('failed');
    expect(effects.speak).not.toHaveBeenCalled();
  });
});

describe('voice: failures are logged and notices do not outlive their turn (#133 review)', () => {
  it('logs every listening failure by code, without words and without a turn (none exists yet)', () => {
    const { actor, effects } = start(never);
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_FAILED', code: 'mic_permission_denied' });
    const other = start(never);
    other.actor.send({ type: 'MIC_PRESSED' });
    other.actor.send({ type: 'RECOGNITION_FAILED', code: 'recognition_network' });
    expect(effects.logVoiceFailure.mock.calls).toEqual([[{ code: 'mic_permission_denied', phase: 'listening', turnId: null }]]);
    expect(other.effects.logVoiceFailure.mock.calls).toEqual([[{ code: 'recognition_network', phase: 'listening', turnId: null }]]);
  });

  it('logs a voice that never starts with the turn of the answer it could not read', async () => {
    const { actor, effects } = start(answer('Hi.'), { speakStartTimeoutMs: 5 });
    actor.send({ type: 'TEXT_SUBMITTED', text: 'q', turnId: 't9' });
    await wait(30);
    expect(effects.logVoiceFailure).toHaveBeenCalledExactlyOnceWith({ code: 'speech_start_missing', phase: 'speaking', turnId: 't9' });
  });

  it('clears the old notice on a new question, but remembers the failures (text stays suggested)', () => {
    const { actor } = start(() => Promise.resolve(ok({})));
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_ENDED' });
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_FAILED', code: 'recognition_network' });
    actor.send({ type: 'TEXT_SUBMITTED', text: 'typed instead', turnId: 't2' });
    expect(actor.getSnapshot().context).toMatchObject({ voiceError: null, voiceFailures: 2, suggestText: true });
  });

  it('turns the mic off when the audio capture fails (no device to listen with)', () => {
    const { actor } = start(never);
    actor.send({ type: 'MIC_PRESSED' });
    actor.send({ type: 'RECOGNITION_FAILED', code: 'audio_capture_failed' });
    expect(actor.getSnapshot().context.micAvailable).toBe(false);
  });
});
