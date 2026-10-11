import { SetPreferencesInputSchema, SetPreferencesOutputSchema, toolError, type ConfigChange, type PublicPreferences } from '@cold-reserve/contracts';
import { toolErrorResult, type ToolCallResult } from './agent.js';
import { SCRIPT_FIXTURES, SCRIPTED_LAST_RESORT_TOKEN } from './script-fixtures.js';

// Card actions on the scripted home: the same shapes the MCP tools return, from the script fixtures.

const success = (structuredContent: Record<string, unknown>, text: string): ToolCallResult => ({ content: [{ type: 'text', text }], structuredContent });

/** The degraded mode never acts: a failure is never reported as a success. */
export const refuseAction = (): ToolCallResult =>
  toolErrorResult(toolError('agent_unavailable', "I can't reach the assistant right now, so nothing was changed."));

function applyPlan(args: Record<string, unknown>): ToolCallResult {
  const lastResort = SCRIPT_FIXTURES['last-resort-plan']();
  if (lastResort.tool === 'plan_comfort' && 'id' in lastResort.result && args['planId'] === lastResort.result.id) return applyLastResort(args['lastResortToken']);
  const applied = SCRIPT_FIXTURES['hot-day-applied']();
  if (applied.tool !== 'apply_plan' || args['planId'] !== applied.result.plan.id) {
    return toolErrorResult(toolError('plan_not_found', 'That plan is not known: ask for a new one.'));
  }
  return success(applied.result, 'Plan applied.');
}

/** A last resort in two steps (#160): the first yes returns a confirmation, the second sends it back. */
function applyLastResort(token: unknown): ToolCallResult {
  if (token === undefined) {
    const pending = SCRIPT_FIXTURES['last-resort-pending']();
    return success(pending.result, 'Not applied yet: this is a last resort. Tap "Yes, apply it now" on its card to apply it.');
  }
  if (token !== SCRIPTED_LAST_RESORT_TOKEN) return toolErrorResult(toolError('last_resort_token_invalid', 'That confirmation is not valid: ask for the plan again.'));
  return success(SCRIPT_FIXTURES['last-resort-applied']().result, 'The last-resort plan is applied.');
}

// TODO(#321): this scripted save skips the server's preference rules (core updatePreferences: the safety limits, heating
// at or below cooling, an unconverted °F number); alexa-sim does not depend on core.
function setPreferences(args: Record<string, unknown>, at: string | undefined): ToolCallResult {
  const input = SetPreferencesInputSchema.safeParse(args);
  const view = SCRIPT_FIXTURES.preferences();
  if (!input.success || view.tool !== 'get_preferences') return toolErrorResult(toolError('invalid_input', 'These preferences cannot be saved.'));
  const before = view.result.preferences;
  const change = input.data;
  const after = {
    ...before,
    comfortC: { cooling: change.comfortC?.cooling ?? before.comfortC.cooling, heating: change.comfortC?.heating ?? before.comfortC.heating },
    safeRoomId: change.safeRoomId ?? before.safeRoomId,
    roomPriority: change.roomPriority ?? before.roomPriority,
  };
  // The simulated log, timestamped on the script clock; nothing is logged without one.
  const fields: Array<[string, number | string, number | string]> = [
    ['comfortC.cooling', before.comfortC.cooling, after.comfortC.cooling],
    ['comfortC.heating', before.comfortC.heating, after.comfortC.heating],
    ['safeRoomId', before.safeRoomId, after.safeRoomId],
    ['roomPriority', before.roomPriority.join(','), after.roomPriority.join(',')],
  ];
  const changes: ConfigChange[] =
    at === undefined ? [] : fields.filter(([, from, to]) => from !== to).map(([field, from, to]) => ({ ts: at, field, from, to, by: 'user', confirmed: true }));
  const output = SetPreferencesOutputSchema.safeParse({ preferences: after satisfies Record<keyof PublicPreferences, unknown>, changes });
  return output.success ? success(output.data, 'Preferences saved.') : toolErrorResult(toolError('invalid_input', 'These preferences cannot be saved.'));
}

export function scriptedToolCall(name: string, args: Record<string, unknown>, at: string | undefined): ToolCallResult {
  if (name === 'apply_plan') return applyPlan(args);
  if (name === 'set_preferences') return setPreferences(args, at);
  return toolErrorResult(toolError('invalid_input', `The simulator does not run ${name}.`));
}
