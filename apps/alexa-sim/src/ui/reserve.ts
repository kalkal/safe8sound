import { ReserveOutlookSchema, err, ok, toolError, type ErrorEnvelope, type ReserveOutlook, type Result } from '@cold-reserve/contracts';
import type { Agent, AskContext } from '../agent/agent.js';
import { log as defaultLog, type Log } from '../log.js';

// The cold reserve clock on the idle screen (owner, 11 Oct): the reserve's ice cubes, read with get_reserve_outlook
// on load and when the home or the scenario changes, never polled. A failure is a quiet degraded mode: the clock is
// hidden and one structured line is logged, with the correlation id and nothing of the home.

export async function fetchReserve(agent: Agent, context: AskContext, logEvent: Log = defaultLog): Promise<Result<ReserveOutlook, ErrorEnvelope>> {
  let failure: ErrorEnvelope;
  try {
    const reply = await agent.callTool('get_reserve_outlook', {}, context);
    const outlook = reply.isError === true ? undefined : ReserveOutlookSchema.safeParse(reply.structuredContent);
    if (outlook?.success === true) return ok(outlook.data);
    failure = reply.isError === true ? toolError('agent_unavailable', 'The reserve could not be read.') : toolError('output_schema_violation', 'The reserve came back in an unexpected format.');
  } catch (error) {
    failure = toolError('agent_unavailable', 'The reserve could not be read.');
    logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, error, details: { step: 'reserve_clock' } });
    return err(failure);
  }
  logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, details: { step: 'reserve_clock' } });
  return err(failure);
}
