/** HomeDataSource from the seeded simulator, with the built-in scenarios and the demo home. */
import { HomeProfileSchema, ScenarioIdSchema, type ErrorEnvelope, type HomeProfile, type Result, type ScenarioId } from '@cold-reserve/contracts';
import demoHome from '../data/demo-home.json' with { type: 'json' };
import simulatorParams from '../data/simulator-params.json' with { type: 'json' };
import clearDay from '../scenarios/clear-day.json' with { type: 'json' };
import heatwave from '../scenarios/heatwave.json' with { type: 'json' };
import stormBlackout from '../scenarios/storm-blackout.json' with { type: 'json' };
import reference from '../locations/reference.json' with { type: 'json' };
import { parseSimParams, type SimulatorParams } from './params.js';
import { mergeScenario, parsePlace, type Place } from './place.js';
import type { Scenario } from './scenario.js';

export const packageName = '@cold-reserve/source-simulator';

export { SimulatorParamsSchema, parseSimParams, type SimulatorParams } from './params.js';
export { ScenarioSchema, inputsAt, parseScenario, type Scenario } from './scenario.js';
export { SimulatorSource, type SimulatorSourceOptions } from './simulator-source.js';
export { createSimulatedDevices, type SimulatedDevices } from './devices.js';
export { PlaceSchema, ScriptSchema, mergeScenario, parsePlace, profileAtPlace, type Place } from './place.js';

/** The built-in scenarios: their ids live in contracts (C1, approved in #214), so sandbox settings can name them. */
export const SCENARIO_IDS = ScenarioIdSchema.options;
export type { ScenarioId };

const RAW_SCRIPTS: Record<ScenarioId, unknown> = { 'clear-day': clearDay, heatwave, 'storm-blackout': stormBlackout };

/** The script file as stored (L1, #217): what happens at home, without the place's day. */
export const rawScript = (id: ScenarioId): unknown => RAW_SCRIPTS[id];

/** The places shipped with the simulator; Turin and Houston come with L2. */
export type BuiltInPlaceId = 'reference';
const RAW_PLACES: Record<BuiltInPlaceId, unknown> = { reference };

/** Built-in data is ours: if it does not validate, that is a bug, so it throws. */
function orThrow<T>(r: Result<T, ErrorEnvelope>): T {
  if (r.ok) return r.value;
  throw new Error(`${r.error.message} ${JSON.stringify(r.error.details?.issues ?? [])}`);
}

/** The demo home: the real plant from spike S6, with example rooms. Placeholder location. */
export const demoProfile = (): HomeProfile => HomeProfileSchema.parse(demoHome);

export const defaultSimParams = (): SimulatorParams => orThrow(parseSimParams(simulatorParams));

/** A built-in place; the `reference` place keeps the numbers the scenarios had before L1. */
export const builtInPlace = (id: BuiltInPlaceId): Place => orThrow(parsePlace(RAW_PLACES[id]));

/** A built-in scenario: its script played in a place (the reference place by default). */
export const builtInScenario = (id: ScenarioId, placeId: BuiltInPlaceId = 'reference'): Scenario =>
  orThrow(mergeScenario(RAW_SCRIPTS[id], builtInPlace(placeId), demoProfile()));

/** The merged scenario as plain data, for tests that change one field and validate it again. */
export const rawScenario = (id: ScenarioId): unknown => structuredClone(builtInScenario(id));
