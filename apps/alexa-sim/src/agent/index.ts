import { ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { SimConfig } from '../config.js';
import type { Agent } from './agent.js';
import { createDemoSession, type DemoSession } from './demo-session.js';
import { withScriptedFallback } from './fallback-agent.js';
import { createRemoteAgent } from './remote-agent.js';
import script from './script.v1.json' with { type: 'json' };
import type { ScriptedPhone } from '../phone/phone-feed.js';
import { createScriptedAgent } from './scripted-agent.js';

export type { Agent, AgentAnswer } from './agent.js';
export type { DemoSession } from './demo-session.js';

/** The demo session of remote mode (#101); scripted mode has none. */
export function buildSession(config: SimConfig): DemoSession | undefined {
  return config.agent === 'scripted' || config.simApiUrl === undefined ? undefined : createDemoSession({ baseUrl: config.simApiUrl, timeoutMs: config.agentTimeoutMs });
}

/**
 * ScriptedAgent by config; otherwise RemoteAgent with the scripted degraded mode behind it.
 * A broken script builds no agent at all: the remote one would have no degraded mode.
 */
export function buildAgent(config: SimConfig, scriptSource: unknown = script, phone?: ScriptedPhone, session?: DemoSession): Result<Agent, ErrorEnvelope> {
  const scripted = createScriptedAgent(scriptSource, phone === undefined ? {} : { phone });
  if (!scripted.ok || config.agent === 'scripted' || config.simApiUrl === undefined) return scripted;
  // Behind the remote agent the script answers status questions only (degraded mode, error-handling §5).
  const degraded = createScriptedAgent(scriptSource, { degraded: true });
  if (!degraded.ok) return degraded;
  return ok(withScriptedFallback(createRemoteAgent({ baseUrl: config.simApiUrl, timeoutMs: config.agentTimeoutMs, ...(session === undefined ? {} : { session }) }), degraded.value));
}
