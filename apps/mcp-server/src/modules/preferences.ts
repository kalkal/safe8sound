import {
  GetPreferencesOutputSchema,
  SetPreferencesInputSchema,
  SetPreferencesOutputSchema,
  effectiveHeatSafety,
  formatTempForInput,
  err,
  ok,
  toPublicPreferences,
  toolError,
  type HomeId,
  type Preferences,
  type SafetyHardLimits,
  type TempUnit,
} from '@cold-reserve/contracts';
import { updatePreferences, type Clock, type Logger, type StateStoreFactory } from '@cold-reserve/core';
import { z } from 'zod';
import type { CapabilityModule } from '../registry.js';
import { homeDetail, isSandbox } from '../sandbox-log.js';
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
  /** For the one warn line of a change the model tried to save from a voice turn (injection hardening, 22 Oct). */
  readonly logger?: Logger;
}

/** A changed field holds a temperature when one of its path segments is a °C value (comfortC, maxC, heatIndexCapC…). */
const isTemperatureField = (field: string): boolean => field.split('.').some((part) => /C$/.test(part));
/** A logged field path as words, "safety.heatIndexCapC" → "safety heat index cap"; room fields without 'Id' (#192). */
const fieldWords = (field: string): string => field.replace(/Id$/, '').replace(/([a-z])C(?=[.]|$)/g, '$1').replace(/[.]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const changeValue = (field: string, value: unknown, unit: TempUnit): string =>
  typeof value === 'number' && isTemperatureField(field) && unit === 'F' ? formatTempForInput(value, unit) : String(value);

// set_preferences overwrites safety thresholds: marked destructive. Our own agent has no host prompt, so the gate is in
// the tool itself (injection hardening, owner's choice A, 22 Oct): a call from a voice turn never saves, whatever the
// model writes in `confirmed`; only the person's tap on Save (the Preferences card, the settings) does.
const annotations = (readOnly: boolean) => ({ readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: false });

export function preferencesModule(deps: PreferencesModuleDeps): CapabilityModule {
  const current = async (homeId: HomeId, correlationId: string) => {
    const saved = await deps.storeFor(homeId, { correlationId }).getPreferences();
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
      const id = o.preferences.safeRoomId;
      const name = deps.roomNameFor?.(ctx.homeId, id);
      // For tool calls only, never said aloud: the ids set_preferences takes (#192).
      const idsLine = ` Room ids for tools (do not say them): ${deps.roomIdsFor(ctx.homeId).map((r) => `${deps.roomNameFor?.(ctx.homeId, r) ?? 'a room'} = ${r}`).join('; ')}.`;
      // The safe room's limits as the guard plays them (#266 review): the maximum, the toggle and both caps.
      const heat = effectiveHeatSafety(o.preferences.safety);
      const unit = deps.unitsFor?.(ctx.homeId) ?? 'C';
      const limits =
        `Safe room limits: at most ${formatTempForInput(o.preferences.safety.cooling.maxC, unit)}, the stricter night limit ${heat.stricterNightLimit ? 'on' : 'off'}, ` +
        `a heat-index cap of ${formatTempForInput(heat.heatIndexCapC, unit)}, an older-person cap of ${formatTempForInput(heat.elderlyCapC, unit)}.`;
      return `${o.isDefault ? 'Default' : 'Saved'} preferences: cool to ${formatTempForInput(o.preferences.comfortC.cooling, unit)}, safe room${name === undefined ? '' : ` ${name}`}. ${limits}${idsLine}`;
    },
    handler: async (_args, ctx) => {
      const read = await current(ctx.homeId, ctx.correlationId);
      if (!read.ok) return read;
      // The rooms by name for the cards and the settings (#422); none when the home has no names.
      const rooms = deps.roomIdsFor(ctx.homeId).flatMap((id) => {
        const name = deps.roomNameFor?.(ctx.homeId, id);
        return name === undefined ? [] : [{ id, name }];
      });
      return ok({ preferences: toPublicPreferences(read.value.preferences), isDefault: read.value.isDefault, hardLimits: deps.limits, ...(rooms.length === 0 ? {} : { rooms }) });
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
      const room = (v: unknown) => String(v).split(',').map((id) => deps.roomNameFor?.(ctx.homeId, id) ?? 'a room').join(', ');
      const val = (field: string, v: unknown) => (field === 'safeRoomId' || field === 'roomPriority' ? room(v) : changeValue(field, v, unit));
      return `Saved: ${o.changes.map((c) => `${fieldWords(c.field)} from ${val(c.field, c.from)} to ${val(c.field, c.to)}`).join(', ')}.`;
    },
    handler: async (args, ctx) => {
      // A voice turn carries its turn id; a tap on Save carries none. The model cannot confirm for the person. The client's
      // scope decides too (security review): the agent's client or a read-only one never saves, even with no turn id.
      if (ctx.turnId !== undefined || ctx.scope === 'agent' || ctx.scope === 'read') {
        const refused = toolError(
          'confirmation_required',
          'Not saved: a change to the preferences is saved only by the person, on the Preferences card. Call get_preferences to show the card, tell them the change, and ask them to make it there and press Save.',
        );
        // A validation error is not logged by the handler: this one is, once, with the fields the model tried (never their values).
        deps.logger?.log({
          ts: new Date(deps.clock.now()).toISOString(),
          level: 'warn',
          component: 'mcp-server',
          message: 'set_preferences came from a voice turn: refused, only a tap on Save saves.',
          correlationId: ctx.correlationId,
          ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
          code: refused.code,
          category: refused.category,
          details: { event: 'set_preferences_in_turn', fields: Object.keys(args).filter((k) => k !== 'confirmed'), ...homeDetail(ctx.homeId) },
        });
        return err(refused);
      }
      const read = await current(ctx.homeId, ctx.correlationId);
      if (!read.ok) return read;
      // `confirmed` is checked by the input schema (literal true); the rest is the update.
      const update = { ...args, confirmed: undefined };
      const next = updatePreferences(read.value.preferences, update, {
        limits: deps.limits,
        roomIds: deps.roomIdsFor(ctx.homeId),
        roomNames: Object.fromEntries(deps.roomIdsFor(ctx.homeId).flatMap((id) => { const n = deps.roomNameFor?.(ctx.homeId, id); return n === undefined ? [] : [[id, n]]; })),
        at: new Date((deps.clockFor?.(ctx.homeId) ?? deps.clock).now()).toISOString(),
        by: 'user',
        // Only a tap reaches here (a voice turn is refused above): the change log says it came through the tool.
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
