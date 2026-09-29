import {
  ForecastSchema,
  HomeProfileSchema,
  PreferencesSchema,
  SnapshotSchema,
  celsius,
  pct,
  type Forecast,
  type HomeProfile,
  type HvacMode,
  type Level,
  type LevelStep,
  type PlanStep,
  type Preferences,
  type Snapshot,
} from '@cold-reserve/contracts';
import { exampleForecast, exampleHomeProfile, examplePreferences, exampleSnapshot } from '@cold-reserve/contracts/fixtures';
import type { SimParams } from '@cold-reserve/core';
import rawConfig from '../config/guard.json' with { type: 'json' };
import { parseGuardConfig, type GuardConfig } from '../src/config.js';
import type { CandidatePlan, GuardInput } from '../src/context.js';

// Shared inputs for the guard tests: the example home (3 rooms, safe room first), a hot night.

export const H = 3_600_000;
export const MIN = 60_000;
/** 20:00 in Rome, summer. */
export const T0 = Date.parse('2026-07-15T20:00:00+02:00');
export const iso = (ms: number) => new Date(ms).toISOString();

export const profile: HomeProfile = HomeProfileSchema.parse(exampleHomeProfile());
/**
 * The example preferences with the widest humidity band the hard limits allow (30-70 %): these tests are
 * about the other guarantees; the humidity bounds have their own tests in constraints.test.ts.
 */
export const preferences: Preferences = PreferencesSchema.parse({
  ...examplePreferences(),
  safety: { ...examplePreferences().safety, humidity: { minPct: 30, maxPct: 70 } },
});

export const params: SimParams = {
  hvac: { dryInputFactor: 0.5, drySensibleFactor: 0.3, fanOnlyInputW: 30 },
  gains: { perRoomBaseW: 50, perOccupantW: 80 },
  solarApertureM2: { default: 0.3, byRoom: {} },
  humidity: {
    exchangeTimeConstantH: 3,
    roomVolumeM3: { default: 35, byRoom: {} },
    occupantGainGph: 60,
    baseGainGph: 30,
    removalLphPerCoolingKw: 0.33,
    dryRemovalFactor: 0.6,
    rating: { tempC: 27, rhPct: 47 },
    coilDewpointC: 8,
  },
  pv: { lossRatio: 0.14 },
  load: { noiseRatio: 0.05 },
};

export function config(over: (c: GuardConfig) => GuardConfig = (c) => c): GuardConfig {
  const parsed = parseGuardConfig(rawConfig);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return over(parsed.value);
}

/** 14 hours from 20:00: a hot night (30 °C falling to 24 °C, 40 % RH), sun back from 07:00. */
export function hotNight(): Forecast {
  const irr = [60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 350, 550];
  return ForecastSchema.parse({
    ...exampleForecast(),
    fetchedAt: iso(T0 - H),
    hourly: irr.map((irradianceWm2, i) => ({
      ts: iso(T0 + i * H),
      tempOutC: Math.max(24, 30 - i * 0.6),
      humidityOutPct: 40,
      irradianceWm2,
      stormProb: 0,
    })),
  });
}

export function snapshot(over: { socPct?: number; gridAvailable?: boolean; tempC?: number; ms?: number } = {}): Snapshot {
  const base = exampleSnapshot();
  const tempC = over.tempC ?? 28;
  return SnapshotSchema.parse({
    ...base,
    ts: iso(over.ms ?? T0),
    batterySocPct: over.socPct ?? 90,
    gridAvailable: over.gridAvailable ?? true,
    gridW: 0,
    rooms: [
      { id: 'bedroom-1', tempC, humidityPct: 50, occupants: ['grandpa'], fanOn: false },
      { id: 'living', tempC, humidityPct: 50, occupants: [] },
      { id: 'study', tempC, humidityPct: 50, occupants: [] },
    ],
  });
}

export const LADDER: LevelStep[] = [
  { level: 'comfort', setpointOffsetK: 0, fansOn: false, preferredModes: ['cool'], roomIds: ['bedroom-1', 'living', 'study'] },
  { level: 'balanced', setpointOffsetK: 1, fansOn: true, preferredModes: ['dry', 'cool'], roomIds: ['bedroom-1', 'living'] },
  { level: 'saver', setpointOffsetK: 2, fansOn: true, preferredModes: ['dry', 'cool'], roomIds: ['bedroom-1'] },
  { level: 'essential', setpointOffsetK: 0, fansOn: true, preferredModes: ['dry', 'cool'], roomIds: ['bedroom-1'] },
];

export function step(o: { atMs?: number; roomId?: string; mode?: HvacMode; setpointC?: number; fanOn?: boolean; level?: Level; targetPct?: number }): PlanStep {
  return {
    ts: iso(o.atMs ?? T0),
    roomId: o.roomId ?? 'bedroom-1',
    hvacMode: o.mode ?? 'cool',
    setpointC: celsius(o.setpointC ?? 25),
    fanOn: o.fanOn ?? true,
    level: o.level ?? 'comfort',
    batteryTargetSocPct: pct(o.targetPct ?? 40),
  };
}

export function plan(steps: PlanStep[], horizonMs = T0 + 12 * H): CandidatePlan {
  return { horizonAt: iso(horizonMs), steps, ladder: LADDER };
}

export function input(over: Partial<GuardInput> = {}): GuardInput {
  return {
    plan: plan([step({})]),
    snapshot: snapshot(),
    forecast: hotNight(),
    profile,
    preferences,
    season: 'cooling',
    model: params,
    config: config(),
    nightRecoveryMode: 'standard',
    ...over,
  };
}
