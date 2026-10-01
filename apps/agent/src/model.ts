import type { Model } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import type { AgentConfig } from './config.js';

/**
 * The model of the config (G1a): the fake one locally and in tests, Bedrock (Nova 2 Lite, id and region
 * from config only) on AgentCore. Building it calls nothing; the token cap of the cost rule goes with it.
 */
export function createModel(config: AgentConfig, fake: () => Model): Model {
  if (config.model.provider === 'fake') return fake();
  return new BedrockModel({ modelId: config.model.modelId, region: config.model.region, maxTokens: config.maxTokens });
}
