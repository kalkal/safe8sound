import type { ErrorCategory } from '@cold-reserve/contracts';
import type { Agent } from './agent.js';

// Degraded mode for "Bedrock / AgentCore down" (error-handling §5): scripted status answers + a clear notice.
// Quota, permission and validation errors are not outages: they reach the user as they are.
const DEGRADE_ON: ReadonlySet<ErrorCategory> = new Set(['dependency_unavailable', 'internal']);

export function withScriptedFallback(primary: Agent, scripted: Agent): Agent {
  return {
    canCallTools: primary.canCallTools,
    // Actions never fall back to the script: a scripted success would claim what did not happen.
    callTool: (name, args, context) => primary.callTool(name, args, context),
    ask: async (question, context) => {
      const result = await primary.ask(question, context);
      if (result.ok || !DEGRADE_ON.has(result.error.category)) return result;
      const fallback = await scripted.ask(question, context);
      if (!fallback.ok) return result;
      // The degraded mode never shows a card: a scripted plan or "applied" would claim what did not happen.
      const { text, status } = fallback.value;
      return { ok: true, value: { text, ...(status !== undefined && { status }), degradedBy: result.error.code } };
    },
  };
}
