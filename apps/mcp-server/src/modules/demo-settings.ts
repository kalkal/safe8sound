import {
  GetDemoSettingsOutputSchema,
  SetScenarioInputSchema,
  SetScenarioOutputSchema,
  defaultUnitOf,
  err,
  ok,
  toolError,
  type ErrorEnvelope,
  type GetDemoSettingsOutput,
  type HomeId,
  type LocationId,
  type Result,
  type SandboxSettings,
  type SetScenarioInput,
} from '@cold-reserve/contracts';
import { playedHousehold, type Clock, type Logger, type StateStoreFactory } from '@cold-reserve/core';
import { z } from 'zod';
import type { CapabilityModule } from '../registry.js';
import { homeDetail, isSandbox } from '../sandbox-log.js';
import { defineTool } from '../tool.js';
import { demoClockTools, type DemoClockDeps } from './demo-clock.js';

// `demo-settings` capability module (C2b, #222; contracts approved in #222): a visitor chooses what their own sandbox
// plays (the scenario, the place, the units, who is at home) or starts the day again. Only visitor sandboxes list
// it; the handler refuses any other home as a second defence. Health thresholds are never settings.

/** The settings a sandbox plays before the visitor saves any (C2b Q3: built-in, the same as today's sandbox). */
export type SandboxChoices = Pick<SandboxSettings, 'scenarioId' | 'locationId' | 'units' | 'household'>;

export type PlaceView = GetDemoSettingsOutput['place'];

export interface DemoSettingsDeps {
  readonly storeFor: StateStoreFactory;
  /** Wall clock: settings are shared by every container, so their times are real ones. */
  readonly wallClock: Clock;
  readonly defaults: SandboxChoices;
  /** A shipped place (reference, Turin, Houston since L2, #247), or undefined for one the simulator does not ship. */
  readonly place: (id: LocationId) => PlaceView | undefined;
  readonly logger: Logger;
  /** Plays the new settings in this container at once; the others see them at their next request. */
  readonly onChange?: (homeId: HomeId, settings: SandboxSettings, correlationId: string) => Promise<void>;
  /** The judges' clock (#311): with it, the sandbox lists its next moments and jumps to one. */
  readonly clock?: DemoClockDeps;
}

const CHOICES = ['scenarioId', 'locationId', 'units', 'household'] as const;

const notHere = (): ErrorEnvelope => toolError('home_not_allowed', 'Only a visitor sandbox has demo settings.');

/** Every value, said: the model repeats the summary, so it must carry each number and choice (F7). Who is at home as the
 * sandbox plays it (core's playedHousehold): a saved 'older-woman' is the older man (20 Oct). */
function describe(settings: SandboxSettings, place: PlaceView | undefined): string {
  const where = place === undefined ? settings.locationId : `${place.label} (${place.tz})`;
  return `Scenario ${settings.scenarioId} in ${where}, temperatures in °${settings.units}, at home: ${playedHousehold(settings.household)}; settings version ${String(settings.version)}.`;
}

export function demoSettingsModule(deps: DemoSettingsDeps): CapabilityModule {
  /** The stored settings, or the defaults (version 0: nothing stored yet). */
  const read = async (homeId: HomeId, correlationId: string): Promise<Result<{ settings: SandboxSettings; version: number | undefined }, ErrorEnvelope>> => {
    const stored = await deps.storeFor(homeId, { correlationId }).getSandboxSettings();
    if (stored.ok) return ok({ settings: stored.value, version: stored.value.version });
    if (stored.error.code !== 'settings_not_found') return stored;
    const settings: SandboxSettings = { version: 1, updatedAt: new Date(deps.wallClock.now()).toISOString(), ...deps.defaults };
    return ok({ settings, version: undefined });
  };

  const getDemoSettings = defineTool({
    name: 'get_demo_settings',
    title: 'Get demo settings',
    description: "This demo sandbox's settings: the scenario played, the place it happens in, the temperature units and who is at home.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: z.strictObject({}),
    output: GetDemoSettingsOutputSchema,
    summarize: (o) => describe(o.settings, o.place),
    handler: async (_args, ctx) => {
      if (!isSandbox(ctx.homeId)) return err(notHere());
      const current = await read(ctx.homeId, ctx.correlationId);
      if (!current.ok) return current;
      const place = deps.place(current.value.settings.locationId);
      if (place === undefined) return err(toolError('invalid_config', 'The stored place is not available.', { details: { field: 'locationId' } }));
      return ok({ settings: current.value.settings, place });
    },
  });

  const setScenario = defineTool({
    name: 'set_scenario',
    title: 'Change the demo scenario',
    description:
      "Changes what this demo sandbox plays: the scenario (clear-day, heatwave, storm-blackout), the place, the temperature units or who is at home (older-man, no-one-at-risk); restart: true plays the day again from its start. A new scenario or place also starts the day again. Only the visitor's own sandbox changes.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: SetScenarioInputSchema,
    output: SetScenarioOutputSchema,
    summarize: (o) => `Saved: ${describe(o.settings, undefined)}${o.restarted ? ' The day starts again from its beginning.' : ''}`,
    handler: async (args: SetScenarioInput, ctx) => {
      if (!isSandbox(ctx.homeId)) return err(notHere());
      if (args.locationId !== undefined && deps.place(args.locationId) === undefined) {
        return err(toolError('invalid_input', 'This place is not available yet.', { details: { field: 'locationId' } }));
      }
      const current = await read(ctx.homeId, ctx.correlationId);
      if (!current.ok) return current;
      const before = current.value.settings;
      // °F everywhere (owner decision, 9 Oct): a new place starts in its own unit (Houston in °F), unless one is sent with it.
      const newPlace = args.locationId !== undefined && args.locationId !== before.locationId;
      const wanted: SetScenarioInput = newPlace && args.units === undefined && args.locationId !== undefined ? { ...args, units: defaultUnitOf(args.locationId) } : args;
      const changed = CHOICES.filter((field) => wanted[field] !== undefined && wanted[field] !== before[field]);
      const restarted = args.restart === true || changed.includes('scenarioId') || changed.includes('locationId');
      if (changed.length === 0 && !restarted) return ok({ settings: before, restarted: false });

      const now = new Date(deps.wallClock.now()).toISOString();
      const next: SandboxSettings = {
        ...before,
        ...Object.fromEntries(changed.map((field) => [field, wanted[field]])),
        version: (current.value.version ?? 0) + 1,
        updatedAt: now,
        ...(restarted ? { scenarioStartedAt: now } : {}),
      };
      // A restart is the only way back (#311): the day plays again from its start, with no jump.
      if (restarted) delete next.advancedMs;
      const saved = await deps.storeFor(ctx.homeId, { correlationId: ctx.correlationId }).putSandboxSettings(next, current.value.version);
      if (!saved.ok) return saved;
      for (const field of [...changed, ...(args.restart === true ? (['restart'] as const) : [])]) {
        deps.logger.log({
          ts: now,
          level: 'info',
          component: 'mcp-server',
          message: `Sandbox setting ${field} changed.`,
          correlationId: ctx.correlationId,
          details: {
            event: 'config_change',
            area: 'sandbox',
            field,
            ...(field === 'restart' ? { to: now } : { from: before[field], to: next[field] }),
            by: 'visitor',
            ...homeDetail(ctx.homeId),
          },
        });
      }
      await deps.onChange?.(ctx.homeId, next, ctx.correlationId);
      return ok({ settings: next, restarted });
    },
  });

  const clockTools =
    deps.clock === undefined
      ? []
      : demoClockTools(
          deps.clock,
          {
            read,
            save: async (homeId, next, expected, correlationId) => {
              const saved = await deps.storeFor(homeId, { correlationId }).putSandboxSettings(next, expected);
              if (!saved.ok) return saved;
              await deps.onChange?.(homeId, next, correlationId);
              return ok(undefined);
            },
          },
          { wallClock: deps.wallClock, logger: deps.logger },
        );

  return { id: 'demo-settings', tools: [getDemoSettings, setScenario, ...clockTools], enabledFor: isSandbox };
}
