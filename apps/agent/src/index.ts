/** The agent (issue #17): Strands loop, versioned prompts, model behind config (fake locally, Bedrock after S2). */
export const packageName = '@cold-reserve/agent';

export { createAgent, type AgentLogEntry, type AgentTurn, type ColdReserveAgent } from './agent.js';
export { classifyFailure, type Failure } from './failure.js';
export { mcpTools } from './mcp.js';
export { AgentConfigSchema, McpToken, loadAgentConfig, loadInvokeToken, loadMcpToken, type AgentConfig } from './config.js';
export { FakeModel, type FakeCall, type FakePolicy, type FakeReply } from './fake-model.js';
export { FEW_SHOT, PLAN_TOOLS, PROMPT_VERSION, SYSTEM_PROMPT_TEMPLATE, buildSystemPrompt, type Dialogue } from './prompts.js';
export { EVAL_SUITE, EvalSuiteSchema, type EvalCase, type EvalSuite } from './evals/cases.js';
export { runEvals, type CaseResult, type EvalReport } from './evals/harness.js';
export { scoreCase, type CaseScore } from './evals/metrics.js';
export { createHomeAgent } from './home-agent.js';
export { createInvocationHandler, type HomeAgent } from './invocations.js';
export { connectMcp, createTurnRecorder, mcpRequestHeaders, mcpToolset, withCorrelationHeader, type McpSession, type TurnRecorder } from './mcp-tools.js';
export { logLine } from './log.js';
export { homeAgents } from './sessions.js';
