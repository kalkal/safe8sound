/** The agent (issue #17): Strands loop, versioned prompts, model behind config (fake locally, Bedrock after S2). */
export const packageName = '@cold-reserve/agent';

export { createAgent, type AgentLogEntry, type AgentTurn, type ColdReserveAgent } from './agent.js';
export { classifyFailure, type Failure } from './failure.js';
export { mcpTools } from './mcp.js';
export { AgentConfigSchema, loadAgentConfig, type AgentConfig } from './config.js';
export { FakeModel, type FakeCall, type FakePolicy, type FakeReply } from './fake-model.js';
export { FEW_SHOT, PLAN_TOOLS, PROMPT_VERSION, SYSTEM_PROMPT_TEMPLATE, buildSystemPrompt, type Dialogue } from './prompts.js';
