import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';

/** What the fake sees of a model call: enough to decide, and to assert on in tests. */
export interface FakeCall {
  readonly messageCount: number;
  readonly lastUserText: string;
  /** Text of the tool results of the current turn, oldest first. */
  readonly toolResults: readonly string[];
  readonly systemPrompt: string;
  readonly toolNames: readonly string[];
}

export type FakeReply = { readonly text: string } | { readonly toolUse: { readonly name: string; readonly input: Record<string, unknown> } };

/** Decides the next reply from the conversation: deterministic, so tests and evals are repeatable. */
export type FakePolicy = (call: FakeCall) => FakeReply;

const textOf = (blocks: Message['content']): string =>
  blocks
    .map((b) => {
      if (b.type === 'textBlock') return b.text;
      if (b.type === 'toolResultBlock') return b.content.map((c) => (c.type === 'textBlock' ? c.text : c.type === 'jsonBlock' ? JSON.stringify(c.json) : '')).join('');
      return '';
    })
    .join('');

/**
 * The model port for tests and local runs (cost rule: no Bedrock in tests or CI). Plugs into the
 * real Strands loop as a custom provider; Spike S2 swaps it for the Bedrock model from config.
 */
export class FakeModel extends Model {
  readonly calls: FakeCall[] = [];
  #config: BaseModelConfig = { modelId: 'fake' };
  #toolUses = 0;
  readonly #policy: FakePolicy;

  constructor(policy: FakePolicy) {
    super();
    this.#policy = policy;
  }

  updateConfig(config: BaseModelConfig): void {
    this.#config = { ...this.#config, ...config };
  }

  getConfig(): BaseModelConfig {
    return this.#config;
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    const lastUser = messages.findLastIndex((m) => m.role === 'user' && m.content.some((b) => b.type === 'textBlock'));
    const turn = messages.slice(Math.max(0, lastUser));
    const call: FakeCall = {
      messageCount: messages.length,
      lastUserText: lastUser >= 0 ? textOf(messages[lastUser]?.content ?? []) : '',
      toolResults: turn.flatMap((m) => m.content.filter((b) => b.type === 'toolResultBlock').map((b) => textOf([b]))),
      systemPrompt: typeof options?.systemPrompt === 'string' ? options.systemPrompt : JSON.stringify(options?.systemPrompt ?? ''),
      toolNames: (options?.toolSpecs ?? []).map((s) => s.name),
    };
    this.calls.push(call);
    const reply = this.#policy(call);

    yield await Promise.resolve({ type: 'modelMessageStartEvent', role: 'assistant' });
    if ('text' in reply) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: reply.text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
      return;
    }
    const toolUseId = `fake-${String(++this.#toolUses)}`;
    yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: reply.toolUse.name, toolUseId } };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(reply.toolUse.input) } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
  }
}
