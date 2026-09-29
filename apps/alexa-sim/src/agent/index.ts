import { ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { SimConfig } from '../config.js';
import type { Agent } from './agent.js';
import { withScriptedFallback } from './fallback-agent.js';
import { createRemoteAgent } from './remote-agent.js';
import script from './script.v1.json' with { type: 'json' };
import { createScriptedAgent } from './scripted-agent.js';

export type { Agent, AgentAnswer } from './agent.js';

/**
 * ScriptedAgent by config; otherwise RemoteAgent with the scripted degraded mode behind it.
 * A broken script builds no agent at all: the remote one would have no degraded mode.
 */
export function buildAgent(config: SimConfig, scriptSource: unknown = script): Result<Agent, ErrorEnvelope> {
  const scripted = createScriptedAgent(scriptSource);
  if (!scripted.ok || config.agent === 'scripted' || config.simApiUrl === undefined) return scripted;
  return ok(withScriptedFallback(createRemoteAgent({ baseUrl: config.simApiUrl, timeoutMs: config.agentTimeoutMs }), scripted.value));
}
