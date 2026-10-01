import './no-network.js';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import { FakeModel } from '../src/fake-model.js';
import { createModel } from '../src/model.js';
import { blockedConnections } from './no-network.js';

// G1a: the model comes from config. Building the Bedrock model calls nothing (cost rule: no LLM in tests
// or CI); the first real turn happens after the deploy, by hand.

const BASE: AgentConfig = {
  model: { provider: 'fake' },
  maxTokens: 400,
  maxModelTurns: 7,
  maxToolCalls: 6,
  historyWindowMessages: 12,
  turnDeadlineMs: 7000,
  mcpUrl: 'http://127.0.0.1:3316/mcp',
};

describe('createModel: the model of the config', () => {
  it('returns the fake model for provider fake', () => {
    const fake = new FakeModel(() => ({ text: 'ok' }));
    expect(createModel(BASE, () => fake)).toBe(fake);
  });

  it('builds the Bedrock model with the id and the token cap of the config, without any network call', () => {
    const config: AgentConfig = { ...BASE, maxTokens: 300, model: { provider: 'bedrock', modelId: 'us.amazon.nova-2-lite-v1:0', region: 'us-east-1' } };
    const model = createModel(config, () => {
      throw new Error('the fake model must not be built for bedrock');
    });
    expect(model).toBeInstanceOf(BedrockModel);
    expect((model as BedrockModel).getConfig()).toMatchObject({ modelId: 'us.amazon.nova-2-lite-v1:0', maxTokens: 300 });
    expect(blockedConnections).toEqual([]);
  });
});
