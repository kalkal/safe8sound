import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import { conversationMachine, type AskInput, type AskOutput } from '../src/machine.js';

type Outcome = Result<AskOutput, ErrorEnvelope>;

function start(ask: (input: AskInput) => Promise<Outcome>, replyTimeoutMs = 1_000) {
  const machine = conversationMachine.provide({ actors: { askAgent: fromPromise<Outcome, AskInput>(({ input }) => ask(input)) } });
  const actor = createActor(machine, { input: { replyTimeoutMs } });
  actor.start();
  return actor;
}

const never = () => new Promise<Outcome>(() => undefined);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const submit = (text: string, turnId = 't1') => ({ type: 'TEXT_SUBMITTED' as const, text, turnId });

describe('conversation machine (plan §9.3)', () => {
  it('starts idle', () => {
    expect(start(never).getSnapshot().value).toBe('idle');
  });

  it('goes idle → thinking → showingAnswer and asks with the trimmed question and the turn id', async () => {
    const asked: AskInput[] = [];
    const actor = start((input) => {
      asked.push(input);
      return Promise.resolve(ok({}));
    });
    actor.send(submit("  What's my battery level?  "));
    expect(actor.getSnapshot().value).toBe('thinking');
    await settle();
    expect(actor.getSnapshot().value).toBe('showingAnswer');
    expect(asked).toEqual([{ question: "What's my battery level?", turnId: 't1' }]);
    expect(actor.getSnapshot().context).toMatchObject({ turnId: 't1', error: null });
  });

  it('ignores an empty question', () => {
    const actor = start(never);
    actor.send(submit('   '));
    expect(actor.getSnapshot().value).toBe('idle');
  });

  it('forbids a second question while thinking', () => {
    const actor = start(never);
    actor.send(submit('first', 't1'));
    actor.send(submit('second', 't2'));
    expect(actor.getSnapshot().value).toBe('thinking');
    expect(actor.getSnapshot().context).toMatchObject({ question: 'first', turnId: 't1' });
  });

  it('forbids RETRY and DISMISS outside their states', () => {
    const actor = start(never);
    actor.send({ type: 'RETRY', turnId: 'x' });
    actor.send({ type: 'DISMISS' });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.send(submit('q'));
    actor.send({ type: 'RETRY', turnId: 'x' });
    actor.send({ type: 'DISMISS' });
    expect(actor.getSnapshot().value).toBe('thinking');
  });

  it('cancels a pending turn back to idle', () => {
    const actor = start(never);
    actor.send(submit('q'));
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('idle');
  });

  it('accepts a new question from showingAnswer, and DISMISS goes back to idle', async () => {
    const actor = start(() => Promise.resolve(ok({})));
    actor.send(submit('one', 't1'));
    await settle();
    actor.send(submit('two', 't2'));
    expect(actor.getSnapshot().context).toMatchObject({ question: 'two', turnId: 't2' });
    await settle();
    actor.send({ type: 'DISMISS' });
    expect(actor.getSnapshot().value).toBe('idle');
  });

  it('shows an agent error value in the failed state', async () => {
    const failure = toolError('agent_unavailable', 'The assistant is unreachable.');
    const actor = start(() => Promise.resolve(err(failure)));
    actor.send(submit('q'));
    await settle();
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toEqual(failure);
  });

  it('turns an unexpected throw into an internal error, never a blank screen', async () => {
    const actor = start(() => Promise.reject(new Error('boom')));
    actor.send(submit('q'));
    await settle();
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toMatchObject({ code: 'unexpected_error', retryable: false });
  });

  it('fails with agent_timeout when the turn budget runs out', async () => {
    const actor = start(never, 5);
    actor.send(submit('q'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toMatchObject({ code: 'agent_timeout', retryable: true });
  });

  it('retries a transient error once, with a new turn id, then offers only a new question', async () => {
    const asked: AskInput[] = [];
    const actor = start((input) => {
      asked.push(input);
      return Promise.resolve(err(toolError('agent_unavailable', 'Unreachable.')));
    });
    actor.send(submit('q', 't1'));
    await settle();
    actor.send({ type: 'RETRY', turnId: 't2' });
    expect(actor.getSnapshot().value).toBe('thinking');
    await settle();
    expect(actor.getSnapshot().context.canRetry).toBe(false);
    actor.send({ type: 'RETRY', turnId: 't3' });
    expect(actor.getSnapshot().value).toBe('failed');
    expect(asked.map((a) => a.turnId)).toEqual(['t1', 't2']);
    actor.send(submit('again', 't4'));
    expect(actor.getSnapshot().value).toBe('thinking');
  });

  it('never retries a non-transient error', async () => {
    const actor = start(() => Promise.resolve(err(toolError('output_schema_violation', 'Bad reply.'))));
    actor.send(submit('q'));
    await settle();
    expect(actor.getSnapshot().context.canRetry).toBe(false);
    actor.send({ type: 'RETRY', turnId: 't2' });
    expect(actor.getSnapshot().value).toBe('failed');
  });
});
