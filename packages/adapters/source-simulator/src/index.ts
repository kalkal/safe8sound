/** HomeDataSource from the seeded simulator, with the built-in scenarios and the demo home. */
import { HomeProfileSchema, type ErrorEnvelope, type HomeProfile, type Result } from '@cold-reserve/contracts';
import demoHome from '../data/demo-home.json' with { type: 'json' };
import simulatorParams from '../data/simulator-params.json' with { type: 'json' };
import clearDay from '../scenarios/clear-day.json' with { type: 'json' };
import heatwave from '../scenarios/heatwave.json' with { type: 'json' };
import stormBlackout from '../scenarios/storm-blackout.json' with { type: 'json' };
import { parseSimParams, type SimulatorParams } from './params.js';
import { parseScenario, type Scenario } from './scenario.js';

export const packageName = '@cold-reserve/source-simulator';

export { SimulatorParamsSchema, parseSimParams, type SimulatorParams } from './params.js';
export { ScenarioSchema, inputsAt, parseScenario, type Scenario } from './scenario.js';
export { SimulatorSource, type SimulatorSourceOptions } from './simulator-source.js';
export { createSimulatedDevices, type SimulatedDevices } from './devices.js';

export const SCENARIO_IDS = ['clear-day', 'heatwave', 'storm-blackout'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

const RAW_SCENARIOS: Record<ScenarioId, unknown> = { 'clear-day': clearDay, heatwave, 'storm-blackout': stormBlackout };

/** The scenario file as stored, before validation. */
export const rawScenario = (id: ScenarioId): unknown => RAW_SCENARIOS[id];

/** Built-in data is ours: if it does not validate, that is a bug, so it throws. */
function orThrow<T>(r: Result<T, ErrorEnvelope>): T {
  if (r.ok) return r.value;
  throw new Error(`${r.error.message} ${JSON.stringify(r.error.details?.issues ?? [])}`);
}

/** The demo home: the real plant from spike S6, with example rooms. Placeholder location. */
export const demoProfile = (): HomeProfile => HomeProfileSchema.parse(demoHome);

export const defaultSimParams = (): SimulatorParams => orThrow(parseSimParams(simulatorParams));

export const builtInScenario = (id: ScenarioId): Scenario => orThrow(parseScenario(RAW_SCENARIOS[id], demoProfile()));
