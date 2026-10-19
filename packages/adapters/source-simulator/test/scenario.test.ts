import { ErrorEnvelopeSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { SCENARIO_IDS, builtInScenario, defaultSimParams, demoProfile, rawScenario } from '../src/index.js';
import { parseSimParams } from '../src/params.js';
import { inputsAt, parseScenario } from '../src/scenario.js';

const profile = demoProfile();
const clone = <T>(x: T): T => structuredClone(x);

describe('built-in scenarios (versioned JSON data)', () => {
  it('are clear-day, heatwave and storm-blackout', () => {
    expect([...SCENARIO_IDS]).toEqual(['clear-day', 'heatwave', 'storm-blackout']);
  });

  it.each(SCENARIO_IDS)('%s parses against the demo profile', (id) => {
    const s = builtInScenario(id);
    expect(s.id).toBe(id);
    expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(s.hourly).toHaveLength(s.durationH);
  });

  it('storm-blackout declares every group simulated and a grid outage', () => {
    const s = builtInScenario('storm-blackout');
    expect([...s.simulatedGroups].sort()).toEqual(['energy', 'rooms', 'weather']);
    expect(s.gridOutages.length).toBeGreaterThan(0);
  });

  it('the default parameters and the demo profile come from spike S6', () => {
    expect(profile.battery).toMatchObject({ usableWh: 13_800, maxChargeW: 5000, maxDischargeW: 5000, minSocHwPct: 10, roundTripEff: 0.884 });
    expect(profile.eps.continuousVa).toBe(5000);
    expect(profile.pvPeakW).toBe(7360);
    expect(defaultSimParams().pv.lossRatio).toBe(0.14);
  });
});

describe('parseScenario errors (invalid_config)', () => {
  const expectInvalid = (raw: unknown, pathPart: string) => {
    const r = parseScenario(raw, profile);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(ErrorEnvelopeSchema.safeParse(r.error).success).toBe(true);
    expect(r.error.code).toBe('invalid_config');
    expect(JSON.stringify(r.error.details?.issues)).toContain(pathPart);
  };

  it('rejects malformed data', () => {
    expectInvalid({ id: 'x' }, 'schemaVersion');
  });

  it('rejects an hourly series that does not cover the duration', () => {
    const raw = clone(rawScenario('clear-day')) as { hourly: unknown[] };
    raw.hourly.pop();
    expectInvalid(raw, 'hourly');
  });

  it('rejects a room that is not in the profile', () => {
    const raw = clone(rawScenario('clear-day')) as { hvac: { roomId: string }[] };
    const first = raw.hvac[0];
    if (first) first.roomId = 'garage';
    expectInvalid(raw, 'garage');
  });

  it('rejects an initial state that misses a profile room', () => {
    const raw = clone(rawScenario('clear-day')) as { initial: { rooms: unknown[] } };
    raw.initial.rooms.pop();
    expectInvalid(raw, 'initial.rooms');
  });

  it('#390: rejects an essential hour at or past the end of the scenario', () => {
    const raw = clone(rawScenario('storm-blackout')) as { essentialAtH?: number; durationH: number };
    expect(parseScenario({ ...raw, essentialAtH: raw.durationH }, profile).ok).toBe(false);
    expect(parseScenario({ ...raw, essentialAtH: raw.durationH - 1 }, profile).ok).toBe(true);
  });

  it('#449: rejects a play-from hour at or past the end of the scenario', () => {
    const raw = clone(rawScenario('clear-day')) as { playFromH?: number; durationH: number };
    expectInvalid({ ...raw, playFromH: raw.durationH }, 'playFromH');
    expect(parseScenario({ ...raw, playFromH: raw.durationH - 1 }, profile).ok).toBe(true);
  });

  it('rejects an initial SOC below the hardware floor', () => {
    const raw = clone(rawScenario('clear-day')) as { initial: { batterySocPct: number } };
    raw.initial.batterySocPct = 5;
    expectInvalid(raw, 'batterySocPct');
  });

  it('rejects a window beyond the scenario end', () => {
    const raw = clone(rawScenario('clear-day')) as { gridOutages: unknown[] };
    raw.gridOutages.push({ fromH: 20, toH: 30 });
    expectInvalid(raw, 'gridOutages');
  });

  it('rejects invalid simulator parameters', () => {
    // A fan never counts above 35 °C of air (UKHSA, WHO, Lancet Planet Health 2024): config cannot raise it.
    expect(parseSimParams({ ...defaultSimParams(), comfort: { ...defaultSimParams().comfort, fanMaxAirC: 35 } }).ok).toBe(true);
    expect(parseSimParams({ ...defaultSimParams(), comfort: { ...defaultSimParams().comfort, fanMaxAirC: 35.5 } }).ok).toBe(false);
    const r = parseSimParams({ ...defaultSimParams(), pv: { lossRatio: 2 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_config');
  });
});

describe('inputsAt', () => {
  const s = builtInScenario('clear-day');

  it('interpolates the hourly weather linearly', () => {
    const [h12, h13] = [s.hourly[12], s.hourly[13]];
    const mid = inputsAt(s, 12.5 * 3600);
    expect(mid.outC).toBeCloseTo(((h12?.tempOutC ?? NaN) + (h13?.tempOutC ?? NaN)) / 2, 9);
    expect(mid.irradianceWm2).toBeCloseTo(((h12?.irradianceWm2 ?? NaN) + (h13?.irradianceWm2 ?? NaN)) / 2, 9);
  });

  it('holds the last hour until the end', () => {
    const last = s.hourly[s.durationH - 1];
    expect(inputsAt(s, s.durationH * 3600).outC).toBe(last?.tempOutC);
  });

  it('applies occupancy and HVAC windows', () => {
    const night = inputsAt(s, 3 * 3600);
    const evening = inputsAt(s, 20 * 3600);
    expect(night.rooms.find((r) => r.id === 'living')?.hvac).toBeUndefined();
    expect(evening.rooms.find((r) => r.id === 'living')?.hvac).toMatchObject({ mode: 'cool' });
  });

  it('switches the grid off inside an outage window only', () => {
    const storm = builtInScenario('storm-blackout');
    const outage = storm.gridOutages[0];
    if (!outage) throw new Error('storm-blackout has an outage');
    expect(inputsAt(storm, (outage.fromH - 0.01) * 3600).gridAvailable).toBe(true);
    expect(inputsAt(storm, outage.fromH * 3600).gridAvailable).toBe(false);
    expect(inputsAt(storm, outage.toH * 3600).gridAvailable).toBe(true);
  });
});
