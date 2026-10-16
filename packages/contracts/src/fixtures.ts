import type { z } from 'zod';
import type { HomeProfileSchema, HvacUnitSchema } from './home.js';
import type { GuaranteeId } from './guarantees.js';
import type { PlanSchema } from './plan.js';
import { ELDERLY_CAP_MAX_C, HEAT_INDEX_CAP_MAX_C, type PreferencesSchema, type SafetyHardLimitsSchema } from './preferences.js';
import type { ReserveOutlookSchema } from './reserve-outlook.js';
import type { ForecastSchema, SnapshotSchema } from './snapshot.js';

// Example inputs for tests in every package. Each call returns a fresh, mutable object.
// Plant values come from spike S6 (issue #10); the location is a placeholder, not the home.

type HvacUnitInput = z.input<typeof HvacUnitSchema>;

const split = (id: string, model: string, coolingKw: number, inputKw: { min: number; nominal: number; max: number }): HvacUnitInput => ({
  id,
  model,
  coolingKw,
  inputKw,
  modes: ['cool', 'heat', 'dry', 'fan_only', 'auto', 'off'],
  controlPath: 'cloud',
});

export function exampleHomeProfile(): z.input<typeof HomeProfileSchema> {
  return {
    schemaVersion: 1,
    homeId: 'demo',
    inverterMaxAcW: 6000,
    eps: { continuousVa: 5000, peakVa: 6000, peakSeconds: 60 },
    battery: { nominalWh: 15_300, usableWh: 13_800, minSocHwPct: 10, maxChargeW: 5000, maxDischargeW: 5000, roundTripEff: 0.884 },
    pvPeakW: 7360,
    rooms: [
      {
        id: 'bedroom-1',
        name: 'Bedroom',
        isSafeRoom: true,
        thermal: { rKPerKw: 10, cKwhPerK: 2 },
        hvacUnits: [split('split-bedroom-1', 'Hisense Easy Smart 12000 BTU', 3.2, { min: 0.19, nominal: 0.97, max: 1.6 })],
        fans: [{ id: 'fan-bedroom-1', powerW: 45, controllable: false }],
      },
      {
        id: 'living',
        name: 'Living room',
        isSafeRoom: false,
        thermal: { rKPerKw: 6, cKwhPerK: 3.5 },
        hvacUnits: [split('split-living', 'Hisense Easy Smart 18000 BTU', 5, { min: 0.26, nominal: 1.55, max: 2.3 })],
        fans: [],
      },
      {
        id: 'study',
        name: 'Study',
        isSafeRoom: false,
        thermal: { rKPerKw: 12, cKwhPerK: 1.6 },
        hvacUnits: [split('split-study', 'Hisense Easy Smart 9000 BTU', 2.6, { min: 0.19, nominal: 0.77, max: 1.5 })],
        fans: [],
      },
    ],
    epsCircuits: ['safe-room', 'router', 'fridge'],
    epsBaseLoadW: 150,
    location: { latRounded: 41.9, lonRounded: 12.5, tz: 'Europe/Rome' },
  };
}

export function exampleSnapshot(): z.input<typeof SnapshotSchema> {
  return {
    schemaVersion: 1,
    homeId: 'demo',
    ts: '2026-07-15T14:00:00+02:00',
    pvW: 5200,
    loadW: 2100,
    batterySocPct: 64,
    gridW: -400,
    gridAvailable: true,
    rooms: [
      { id: 'bedroom-1', tempC: 26.4, humidityPct: 55, occupants: ['grandpa'], hvac: { mode: 'cool', setpointC: 26 }, fanOn: true },
      { id: 'living', tempC: 27.8, humidityPct: 58, occupants: [] },
    ],
    origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'clear-day' },
    homeLink: 'ok',
  };
}

export function exampleForecast(): z.input<typeof ForecastSchema> {
  return {
    fetchedAt: '2026-07-15T13:00:00+02:00',
    confidence: 'high',
    confidenceReason: 'Fresh forecast, stable weather.',
    hourly: [
      { ts: '2026-07-15T14:00:00+02:00', tempOutC: 35, humidityOutPct: 40, irradianceWm2: 820, stormProb: 0.05 },
      { ts: '2026-07-15T15:00:00+02:00', tempOutC: 36, humidityOutPct: 38, irradianceWm2: 760, stormProb: 0.05 },
    ],
    sunrise: ['2026-07-16T05:45:00+02:00'],
    sunset: ['2026-07-15T20:40:00+02:00'],
  };
}

export function examplePlan(): z.input<typeof PlanSchema> {
  const guarantee = (id: GuaranteeId) => ({
    id,
    ok: true,
    reason: 'Holds for the whole horizon.',
  });
  return {
    schemaVersion: 1,
    id: 'plan_7Hq2mX9vK3',
    homeId: 'demo',
    status: 'proposed',
    createdAt: '2026-07-15T14:00:00+02:00',
    expiresAt: '2026-07-15T14:10:00+02:00',
    horizonAt: '2026-07-16T07:00:00+02:00',
    goal: 'cool',
    ladder: [
      { level: 'comfort', setpointOffsetK: 0, fansOn: false, preferredModes: ['cool'], roomIds: ['bedroom-1', 'living'] },
      { level: 'balanced', setpointOffsetK: 1, fansOn: true, preferredModes: ['dry', 'cool'], roomIds: ['bedroom-1', 'living'] },
      { level: 'saver', setpointOffsetK: 2, fansOn: true, preferredModes: ['dry', 'cool'], roomIds: ['bedroom-1'] },
      { level: 'essential', setpointOffsetK: 0, fansOn: true, preferredModes: ['dry', 'cool'], roomIds: ['bedroom-1'] },
    ],
    steps: [
      {
        ts: '2026-07-15T15:00:00+02:00',
        roomId: 'bedroom-1',
        hvacMode: 'cool',
        setpointC: 25,
        fanOn: false,
        level: 'comfort',
        batteryTargetSocPct: 80,
      },
    ],
    reserveWh: 6000,
    guarantees: [
      guarantee('storm_reserve'),
      guarantee('inverter_limit'),
      guarantee('battery_power'),
      guarantee('safe_room_comfort'),
      guarantee('pacing_on_track'),
    ],
    forecastConfidence: 'high',
    confidenceReason: 'Fresh forecast, stable weather.',
    sourceOrigin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'heatwave' },
    advisoryOnly: false,
  };
}

export function examplePreferences(): z.input<typeof PreferencesSchema> {
  return {
    schemaVersion: 1,
    comfortC: { cooling: 25, heating: 20 },
    safeRoomId: 'bedroom-1',
    roomPriority: ['bedroom-1', 'living', 'study'],
    safety: { cooling: { maxC: 27 }, heating: { minC: 18 }, humidity: { minPct: 40, maxPct: 60 } },
    autoStormOnGridLoss: true,
    familyContacts: [{ role: 'daughter', name: 'Example Contact', channel: 'in_app', handle: 'phone-1' }],
    language: 'en-US',
  };
}

/** Example hard limits; the real ones live in config. */
export function exampleSafetyLimits(): z.input<typeof SafetyHardLimitsSchema> {
  return {
    cooling: { maxC: { min: 24, max: 30, default: 27 } },
    heating: { minC: { min: 16, max: 22, default: 18 } },
    humidity: { minPct: { min: 30, max: 50, default: 40 }, maxPct: { min: 50, max: 70, default: 60 } },
    // #402: the heat caps may only be stricter than their health constants (#266); the bounds are those of the config.
    stricterNightLimit: { default: false },
    heatIndexCapC: { min: 26.7, max: HEAT_INDEX_CAP_MAX_C, default: HEAT_INDEX_CAP_MAX_C },
    elderlyCapC: { min: 26, max: ELDERLY_CAP_MAX_C, default: ELDERLY_CAP_MAX_C },
  };
}

/** Ice cubes and reserve hours; the hours match the example home at a mild evening load. */
export function exampleReserveOutlook(): z.input<typeof ReserveOutlookSchema> {
  return {
    level: 'comfort',
    hoursAtCurrentLevel: 9.5,
    hoursAtEssential: 18,
    reserveHoursAtEssential: 10,
    origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' },
    ts: '2026-07-15T21:10:00+02:00',
  };
}
