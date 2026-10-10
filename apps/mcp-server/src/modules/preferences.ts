import {
  GetPreferencesOutputSchema,
  SetPreferencesInputSchema,
  SetPreferencesOutputSchema,
  effectiveHeatSafety,
  formatTempForInput,
  ok,
  toPublicPreferences,
  type HomeId,
  type Preferences,
  type SafetyHardLimits,
  type TempUnit,
} from '@cold-reserve/contracts';
import { updatePreferences, type Clock, type StateStoreFactory } from '@cold-reserve/core';
import { z } from 'zod';
import type { CapabilityModule } from '../registry.js';
import { defineTool } from '../tool.js';

// `preferences` capability module (plan §14.1, issue #20): read and change the comfort setpoints,
// the safety thresholds (inside the hard limits from config), the safe room, the room priority and
// the language. Contacts carry names, so they are never read from or written by the model:
// the tools show roles only, and contacts are edited in the app (plan §3.1, #1·19a).

export interface PreferencesModuleDeps {
  readonly storeFor: StateStoreFactory;
  /** Hard limits and defaults per season, from config. */
  readonly limits: SafetyHardLimits;
  /** Room ids of the home profile. */
  readonly roomIdsFor: (homeId: HomeId) => readonly string[];
  /** A room's name, said instead of its id (#274); undefined when the profile has none. */
  readonly roomNameFor?: (homeId: HomeId, roomId: string) => string | undefined;
  /** What a home uses before anyone saved preferences (from config). */
  readonly defaultsFor: (homeId: HomeId) => Preferences;
  readonly clock: Clock;
  /** A home's own scenario clock (C2b): a change is stamped at that home's time; without one, `clock`. */
  readonly clockFor?: (homeId: HomeId) => Clock | undefined;
  /** The home's temperature unit for the texts (#306); °C when unset. The tools still take °C. */
  readonly unitsFor?: (homeId: HomeId) => TempUnit;
}

/** A changed field holds a temperature when one of its path segments is a °C value (comfortC, maxC, heatIndexCapC…). */
const isTemperatureField = (field: string): boolean => field.split('.').some((part) => /C$/.test(part));
const changeValue = (field: string, value: unknown, unit: TempUnit): string =>
  typeof value === 'number' && isTemperatureField(field) && unit === 'F' ? formatTempForInput(value, unit) : String(value);

// set_preferences overwrites safety thresholds: marked destructive, so the host asks for confirmation.
// That host prompt is the one gate a prompt injection cannot bypass.
const annotations = (readOnly: boolean) => ({ readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: false });

export function preferencesModule(deps: PreferencesModuleDeps): CapabilityModule {
  const current = async (homeId: HomeId) => {
    const saved = await deps.storeFor(homeId).getPreferences();
    if (!saved.ok) return saved;
    return ok(saved.value === undefined ? { preferences: deps.defaultsFor(homeId), isDefault: true } : { preferences: saved.value, isDefault: false });
  };

  const getPreferences = defineTool({
    name: 'get_preferences',
    title: 'Get preferences',
    description:
      "The home's comfort setpoints per season, safety thresholds of the safe room with their hard limits, safe room, room priority and language. Contacts are listed by role only.",
    annotations: annotations(true),
    input: z.strictObject({}),
    output: GetPreferencesOutputSchema,
    summarize: (o, ctx) => {
      // The name for people, the id in parentheses for the model (#274).
      const id = o.preferences.safeRoomId;
      const name = deps.roomNameFor?.(ctx.homeId, id);
      // The safe room's limits as the guard plays them (#266 review): the maximum, the toggle and both caps.
      const heat = effectiveHeatSafety(o.preferences.safety);
      const unit = deps.unitsFor?.(ctx.homeId) ?? 'C';
      const limits =
        `Safe room limits: at most ${formatTempForInput(o.preferences.safety.cooling.maxC, unit)}, the stricter night limit ${heat.stricterNightLimit ? 'on' : 'off'}, ` +
        `a heat-index cap of ${formatTempForInput(heat.heatIndexCapC, unit)}, an older-person cap of ${formatTempForInput(heat.elderlyCapC, unit)}.`;
      return `${o.isDefault ? 'Default' : 'Saved'} preferences: cool to ${formatTempForInput(o.preferences.comfortC.cooling, unit)}, safe room ${name === undefined ? id : `${name} (${id})`}. ${limits}`;
    },
    handler: async (_args, ctx) => {
      const read = await current(ctx.homeId);
      if (!read.ok) return read;
      return ok({ preferences: toPublicPreferences(read.value.preferences), isDefault: read.value.isDefault, hardLimits: deps.limits });
    },
  });

  const setPreferences = defineTool({
    name: 'set_preferences',
    title: 'Change preferences',
    description:
      'Changes comfort setpoints, safety thresholds (only inside the hard limits), the safe room, the room priority (safe room first) or the language. Call it only after the person confirmed the exact change; every change is logged.',
    annotations: annotations(false),
    input: SetPreferencesInputSchema,
    output: SetPreferencesOutputSchema,
    // Every value in the text: the model only sees the text (repo rule on tool summaries).
    summarize: (o, ctx) => {
      if (o.changes.length === 0) return 'Nothing changed.';
      const unit = deps.unitsFor?.(ctx.homeId) ?? 'C';
      return `Saved: ${o.changes.map((c) => `${c.field} from ${changeValue(c.field, c.from, unit)} to ${changeValue(c.field, c.to, unit)}`).join(', ')}.`;
    },
    handler: async (args, ctx) => {
      const read = await current(ctx.homeId);
      if (!read.ok) return read;
      // `confirmed` is checked by the input schema (literal true); the rest is the update.
      const update = { ...args, confirmed: undefined };
      const next = updatePreferences(read.value.preferences, update, {
        limits: deps.limits,
        roomIds: deps.roomIdsFor(ctx.homeId),
        at: new Date((deps.clockFor?.(ctx.homeId) ?? deps.clock).now()).toISOString(),
        by: 'user',
        // The model passed confirmed: true after the host prompt; the log says so, not more.
        confirmedVia: 'tool',
        // Its refusals said in the sandbox's unit, with the °C to send (#306 review).
        unit: deps.unitsFor?.(ctx.homeId) ?? 'C',
      });
      if (!next.ok) return next;
      const saved = await deps.storeFor(ctx.homeId, { correlationId: ctx.correlationId }).putPreferences(next.value.preferences, next.value.changes);
      if (!saved.ok) return saved;
      return ok({ preferences: toPublicPreferences(next.value.preferences), changes: next.value.changes });
    },
  });

  return { id: 'preferences', tools: [getPreferences, setPreferences] };
}
