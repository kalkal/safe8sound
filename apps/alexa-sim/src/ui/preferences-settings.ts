import { ErrorEnvelopeSchema, GetPreferencesOutputSchema, SetPreferencesOutputSchema, err, ok, toolError, type ErrorEnvelope, type GetPreferencesOutput, type Result, type SetPreferencesOutput } from '@cold-reserve/contracts';
import type { Agent, AskContext } from '../agent/agent.js';
import { log as defaultLog, type Log } from '../log.js';
import { callFor } from './demo-settings.js';
import type { LimitChange } from './limits.js';

// #402: the settings section reads the home's preferences (get_preferences) and saves one change at a time
// (set_preferences, the tool the Preferences card uses). The person pressed Save, which is the confirmation.

/** The preferences with the hard limits the section moves inside; a home that cannot say gets no limits rows. */
export function fetchPreferences(agent: Agent, context: AskContext, logEvent: Log = defaultLog): Promise<Result<GetPreferencesOutput, ErrorEnvelope>> {
  return callFor(agent, 'get_preferences', {}, (v) => GetPreferencesOutputSchema.safeParse(v), context, logEvent);
}

/**
 * Saves the draft as one change (one write, the person's Save is the confirmation). The result is what the tool
 * stored: the caller shows it with withSaved, without reading again. A refusal keeps its own code, so the screen can
 * say the real reason (for example the daily limit of the demo's changes).
 */
export async function savePreferences(agent: Agent, change: LimitChange, context: AskContext, logEvent: Log = defaultLog): Promise<Result<SetPreferencesOutput, ErrorEnvelope>> {
  let failure: ErrorEnvelope;
  try {
    const reply = await agent.callTool('set_preferences', { ...change, confirmed: true }, context);
    if (reply.isError === true) {
      const refused = ErrorEnvelopeSchema.safeParse(reply.structuredContent);
      failure = refused.success ? refused.data : toolError('invalid_input', 'The preferences were refused.');
    } else {
      const saved = SetPreferencesOutputSchema.safeParse(reply.structuredContent);
      if (saved.success) {
        logEvent({ level: 'info', code: 'preferences_changed', correlationId: context.correlationId, details: { fields: saved.data.changes.map((c) => c.field) } });
        return ok(saved.data);
      }
      failure = toolError('output_schema_violation', 'The preferences came back in an unexpected format.');
    }
  } catch (error) {
    failure = toolError('agent_unavailable', 'The preferences could not be reached.');
    logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, error, details: { step: 'set_preferences' } });
    return err(failure);
  }
  logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, details: { step: 'set_preferences' } });
  return err(failure);
}
