import { GetPreferencesOutputSchema, SafetyThresholdsSchema, SetPreferencesInputSchema, SetPreferencesOutputSchema, effectiveHeatSafety, toolError, type ConfigChange, type GetPreferencesOutput, type PublicPreferences } from '@cold-reserve/contracts';
import { toolErrorResult, type ToolCallResult } from './agent.js';
import { SCRIPT_FIXTURES, SCRIPTED_LAST_RESORT_TOKEN, demoSafeRoom } from './script-fixtures.js';

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

/** The scripted home's preferences (#402): the fixture, then what the settings and the cards saved, for this agent only. */
export interface ScriptedPreferences {
  read: () => GetPreferencesOutput | undefined;
  save: (next: PublicPreferences) => void;
}

export function createScriptedPreferences(): ScriptedPreferences {
  let current = SCRIPT_FIXTURES.preferences();
  return {
    read: () => (current.tool === 'get_preferences' ? current.result : undefined),
    save: (next) => {
      if (current.tool === 'get_preferences') current = { tool: 'get_preferences', result: { ...current.result, preferences: next, isDefault: false } };
    },
  };
}

function getPreferences(store: ScriptedPreferences): ToolCallResult {
  const view = store.read();
  return view === undefined ? toolErrorResult(toolError('invalid_input', 'The preferences cannot be read.')) : success(GetPreferencesOutputSchema.parse(view), 'Preferences.');
}

// TODO(#330): this scripted save skips the server's preference rules (core updatePreferences: the safety limits, heating
// at or below cooling, an unconverted °F number); alexa-sim does not depend on core. The settings section (#402)
// refuses a move against those rules before it sends one.
function setPreferences(args: Record<string, unknown>, at: string | undefined, store: ScriptedPreferences): ToolCallResult {
  const input = SetPreferencesInputSchema.safeParse(args);
  const view = store.read();
  if (!input.success || view === undefined) return toolErrorResult(toolError('invalid_input', 'These preferences cannot be saved.'));
  const before = view.preferences;
  const change = input.data;
  const heat = effectiveHeatSafety(before.safety);
  const safetyRaw = {
    ...before.safety,
    cooling: { maxC: change.safety?.cooling?.maxC ?? before.safety.cooling.maxC },
    heating: { minC: change.safety?.heating?.minC ?? before.safety.heating.minC },
    humidity: { minPct: change.safety?.humidity?.minPct ?? before.safety.humidity.minPct, maxPct: change.safety?.humidity?.maxPct ?? before.safety.humidity.maxPct },
    ...(change.safety?.stricterNightLimit === undefined ? {} : { stricterNightLimit: change.safety.stricterNightLimit }),
    ...(change.safety?.heatIndexCapC === undefined ? {} : { heatIndexCapC: change.safety.heatIndexCapC }),
    ...(change.safety?.elderlyCapC === undefined ? {} : { elderlyCapC: change.safety.elderlyCapC }),
  };
  // The contract brands the temperatures: they are parsed, never cast.
  const parsedSafety = SafetyThresholdsSchema.safeParse(safetyRaw);
  if (!parsedSafety.success) return toolErrorResult(toolError('invalid_input', 'These preferences cannot be saved.'));
  const safety = parsedSafety.data;
  const after = {
    ...before,
    comfortC: { cooling: change.comfortC?.cooling ?? before.comfortC.cooling, heating: change.comfortC?.heating ?? before.comfortC.heating },
    safeRoomId: change.safeRoomId ?? before.safeRoomId,
    roomPriority: change.roomPriority ?? before.roomPriority,
    safety,
  };
  const played = effectiveHeatSafety(safety);
  // The simulated log, timestamped on the script clock; nothing is logged without one.
  const fields: Array<[string, number | string | boolean, number | string | boolean]> = [
    ['comfortC.cooling', before.comfortC.cooling, after.comfortC.cooling],
    ['comfortC.heating', before.comfortC.heating, after.comfortC.heating],
    ['safeRoomId', before.safeRoomId, after.safeRoomId],
    ['roomPriority', before.roomPriority.join(','), after.roomPriority.join(',')],
    ['safety.cooling.maxC', before.safety.cooling.maxC, safety.cooling.maxC],
    ['safety.heating.minC', before.safety.heating.minC, safety.heating.minC],
    ['safety.stricterNightLimit', heat.stricterNightLimit, played.stricterNightLimit],
    ['safety.heatIndexCapC', heat.heatIndexCapC, played.heatIndexCapC],
    ['safety.elderlyCapC', heat.elderlyCapC, played.elderlyCapC],
  ];
  const changes: ConfigChange[] =
    at === undefined ? [] : fields.filter(([, from, to]) => from !== to).map(([field, from, to]) => ({ ts: at, field, from, to, by: 'user', confirmed: true }));
  const output = SetPreferencesOutputSchema.safeParse({ preferences: after satisfies Record<keyof PublicPreferences, unknown>, changes });
  if (!output.success) return toolErrorResult(toolError('invalid_input', 'These preferences cannot be saved.'));
  store.save(output.data.preferences);
  return success(output.data, 'Preferences saved.');
}

export function scriptedToolCall(name: string, args: Record<string, unknown>, at: string | undefined, preferences: ScriptedPreferences = createScriptedPreferences()): ToolCallResult {
  if (name === 'apply_plan') return applyPlan(args);
  // The idle screen's cold reserve clock (owner, 11 Oct): read-only, the reserve of the scripted home.
  if (name === 'get_reserve_outlook') {
    const reserve = SCRIPT_FIXTURES['reserve-outlook']();
    return success(reserve.result, 'Cold reserve.');
  }
  // The idle screen's tile "Leo's room · safe until …" (#432 S6): read-only, the calm room of the scripted home.
  if (name === 'get_safe_room_status') return success(demoSafeRoom(), 'Safe room.');
  if (name === 'set_preferences') return setPreferences(args, at, preferences);
  if (name === 'get_preferences') return getPreferences(preferences);
  return toolErrorResult(toolError('invalid_input', `The simulator does not run ${name}.`));
}
