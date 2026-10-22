import type { ErrorCategory, ErrorCode } from '@cold-reserve/contracts';
import { log as defaultLog, type Log } from '../log.js';
import type { Agent } from './agent.js';

// Degraded mode for "Bedrock / AgentCore down" (error-handling §5): scripted status answers + a clear notice.
// Quota, permission and validation errors are not outages: they reach the user as they are. Nor is a turn that took
// too long (#270): the assistant is there, so the user reads that and may try again, never a scripted answer.
const DEGRADE_ON: ReadonlySet<ErrorCategory> = new Set(['dependency_unavailable', 'internal']);
const NOT_AN_OUTAGE: ReadonlySet<ErrorCode> = new Set(['agent_timeout']);

export function withScriptedFallback(primary: Agent, scripted: Agent, log: Log = defaultLog): Agent {
  return {
    canCallTools: primary.canCallTools,
    // Actions never fall back to the script: a scripted success would claim what did not happen.
    callTool: (name, args, context) => primary.callTool(name, args, context),
    ask: async (question, context) => {
      const result = await primary.ask(question, context);
      if (result.ok || !DEGRADE_ON.has(result.error.category) || NOT_AN_OUTAGE.has(result.error.code)) return result;
      const fallback = await scripted.ask(question, context);
      const { code } = result.error;
      if (!fallback.ok) {
        log({ level: 'error', code, correlationId: context.correlationId, details: { degraded: false, fallbackCode: fallback.error.code } });
        return result;
      }
      log({ level: 'warn', code, correlationId: context.correlationId, details: { degraded: true } });
      // The degraded mode never shows a card: a scripted plan or "applied" would claim what did not happen.
      const { text, status, example } = fallback.value;
      return { ok: true, value: { text, ...(status !== undefined && { status }), ...(example !== undefined && { example }), degradedBy: code } };
    },
  };
}
