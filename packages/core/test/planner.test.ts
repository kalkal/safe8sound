import { HomeProfileSchema, LevelStepSchema, PlanStepSchema, PreferencesSchema, celsius, pct } from '@cold-reserve/contracts';
import { exampleHomeProfile, examplePreferences } from '@cold-reserve/contracts/fixtures';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildLadder, candidateSteps, dutyCycle, seasonFor, withTargets, type PlannerConfig } from '../src/planner.js';

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

const profile = HomeProfileSchema.parse(exampleHomeProfile());
const preferences = PreferencesSchema.parse(examplePreferences());
const cfg: PlannerConfig = {
  levelOffsetK: { comfort: 0, balanced: 1, saver: 2 },
  essentialMarginK: 0.5,
  dryAboveRhPct: 60,
  targetEveryMinutes: 60,
  dutyCycles: [{ onMinutes: 30, periodMinutes: 60 }],
};
const rung = (ladder: ReturnType<typeof buildLadder>, i: number) => {
  const r = ladder[i];
  if (r === undefined) throw new Error(`no rung ${String(i)}`);
  return r;
};
const T0 = Date.parse('2026-07-15T20:00:00+02:00');
const H = 3_600_000;

describe('buildLadder (plan §4bis table, cooling)', () => {
  const ladder = buildLadder({ season: 'cooling', goal: 'cool', profile, preferences, occupied: ['living'], config: cfg });

  it('goes comfort → balanced → saver → essential and is valid against the contract', () => {
    expect(ladder.map((s) => s.level)).toEqual(['comfort', 'balanced', 'saver', 'essential']);
    for (const s of ladder) LevelStepSchema.parse(s);
  });

  it('raises the setpoint by the configured offsets and turns the fans on from balanced down', () => {
    expect(ladder.map((s) => s.setpointOffsetK)).toEqual([0, 1, 2, 27 - 0.5 - 25]);
    expect(ladder.map((s) => s.fansOn)).toEqual([false, true, true, true]);
  });

  it('serves the safe room and the occupied rooms, and only the safe room in essential', () => {
    expect(ladder[0]?.roomIds).toEqual(['bedroom-1', 'living']);
    expect(ladder[3]?.roomIds).toEqual(['bedroom-1']);
  });

  it('prefers dry from balanced down, cool in comfort', () => {
    expect(ladder[0]?.preferredModes).toEqual(['cool']);
    expect(ladder[1]?.preferredModes).toEqual(['dry', 'cool']);
  });

  it('mirrors in the heating season: lower setpoints and heat', () => {
    const heat = buildLadder({ season: 'heating', goal: 'heat', profile, preferences, occupied: [], config: cfg });
    expect(heat.map((s) => s.setpointOffsetK)).toEqual([0, -1, -2, 18 + 0.5 - 20]);
    expect(heat[0]?.preferredModes).toEqual(['heat']);
  });

  it('the dry goal always prefers dry', () => {
    const dry = buildLadder({ season: 'cooling', goal: 'dry', profile, preferences, occupied: [], config: cfg });
    expect(dry.every((s) => s.preferredModes[0] === 'dry')).toBe(true);
  });
});

describe('candidateSteps', () => {
  const ladder = buildLadder({ season: 'cooling', goal: 'cool', profile, preferences, occupied: ['living', 'study'], config: cfg });
  const input = (level: number, budgetW = 10_000, rh: Record<string, number> = {}) => ({
    ladderStep: rung(ladder, level),
    comfortC: preferences.comfortC.cooling,
    atMs: T0,
    profile,
    priority: preferences.roomPriority,
    budgetW,
    humidityByRoom: rh,
    config: cfg,
  });

  it('sets every served room at comfort + offset, valid steps', () => {
    const steps = candidateSteps(input(1));
    expect(steps.map((s) => [s.roomId, s.hvacMode, s.setpointC, s.fanOn])).toEqual([
      ['bedroom-1', 'cool', 26, true],
      ['living', 'cool', 26, false],
      ['study', 'cool', 26, false],
    ]);
    for (const s of steps) PlanStepSchema.parse(s);
  });

  it('dries a humid room when the level prefers dry', () => {
    const steps = candidateSteps(input(1, 10_000, { 'bedroom-1': 65 }));
    expect(steps[0]?.hvacMode).toBe('dry');
  });

  it('switches off, in priority order, the rooms that do not fit the power budget', () => {
    // 1.6 + 2.3 kW fit 4 kW, the study (1.5 kW) waits.
    const steps = candidateSteps(input(0, 4000));
    expect(steps.map((s) => [s.roomId, s.hvacMode])).toEqual([
      ['bedroom-1', 'cool'],
      ['living', 'cool'],
      ['study', 'off'],
    ]);
  });

  it('property: served rooms never exceed the budget at their maximum input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 8000 }), (level, budgetW) => {
        const steps = candidateSteps(input(level, budgetW));
        const maxW = steps
          .filter((s) => s.hvacMode !== 'off')
          .reduce((sum, s) => {
            const room = profile.rooms.find((r) => r.id === s.roomId);
            return sum + (room?.hvacUnits.reduce((w, u) => w + u.inputKw.max * 1000, 0) ?? 0) + (s.fanOn ? (room?.fans.reduce((w, f) => w + f.powerW, 0) ?? 0) : 0);
          }, 0);
        expect(maxW).toBeLessThanOrEqual(budgetW + 1e-6);
      }),
      { numRuns: runs(10_000) },
    );
  });
});

describe('withTargets', () => {
  it('repeats the safe-room setting every interval, with the lowest SOC of each interval as target', () => {
    const base = candidateSteps({
      ladderStep: rung(buildLadder({ season: 'cooling', goal: 'cool', profile, preferences, occupied: [], config: cfg }), 0),
      comfortC: preferences.comfortC.cooling,
      atMs: T0,
      profile,
      priority: preferences.roomPriority,
      budgetW: 10_000,
      humidityByRoom: {},
      config: cfg,
    });
    // A battery draining 1 % per hour: the lowest SOC of an interval is at its end.
    const soc = (_from: number, to: number) => 90 - (to - T0) / H;
    const steps = withTargets(base, { socMin: soc, fromMs: T0, toMs: T0 + 3 * H, safeRoomId: 'bedroom-1', config: cfg });
    expect(steps.map((s) => [s.ts, s.batteryTargetSocPct])).toEqual([
      [new Date(T0).toISOString(), 89],
      [new Date(T0 + H).toISOString(), 88],
      [new Date(T0 + 2 * H).toISOString(), 87],
    ]);
    expect(new Set(steps.map((s) => s.setpointC))).toEqual(new Set([25]));
  });
});

describe('seasonFor', () => {
  const temps = (...t: number[]) => t.map((tempOutC) => ({ tempOutC }));
  it('follows an explicit goal', () => {
    expect(seasonFor('cool', temps(10), preferences)).toBe('cooling');
    expect(seasonFor('dry', temps(10), preferences)).toBe('cooling');
    expect(seasonFor('heat', temps(35), preferences)).toBe('heating');
  });

  it('with auto, cools when the forecast goes above the cooling comfort, heats when it goes below the heating one', () => {
    expect(seasonFor('auto', temps(22, 25), preferences)).toBe('cooling');
    expect(seasonFor('auto', temps(21, 24.9), preferences)).toBe('neutral');
    expect(seasonFor('auto', temps(22, 20), preferences)).toBe('heating');
    expect(seasonFor('auto', temps(19, 30), preferences)).toBe('cooling');
  });

  it('with auto and no forecast, stays neutral', () => {
    expect(seasonFor('auto', [], preferences)).toBe('neutral');
  });
});

describe('dutyCycle (pacing inside the hour)', () => {
  const on = {
    ts: new Date(T0).toISOString(),
    roomId: 'bedroom-1',
    hvacMode: 'dry' as const,
    setpointC: celsius(26.5),
    fanOn: true,
    level: 'essential' as const,
    batteryTargetSocPct: pct(0),
  };

  it('runs the unit for the first minutes of every period, then only the fan, up to the end', () => {
    const steps = dutyCycle(on, { onMinutes: 20, periodMinutes: 60, fromMs: T0, toMs: T0 + 2 * H });
    expect(steps.map((s) => [s.ts, s.hvacMode, s.fanOn])).toEqual([
      [new Date(T0).toISOString(), 'dry', true],
      [new Date(T0 + 20 * 60_000).toISOString(), 'fan_only', true],
      [new Date(T0 + H).toISOString(), 'dry', true],
      [new Date(T0 + H + 20 * 60_000).toISOString(), 'fan_only', true],
    ]);
  });

  it('is the plain setting when it runs the whole period', () => {
    expect(dutyCycle(on, { onMinutes: 60, periodMinutes: 60, fromMs: T0, toMs: T0 + 2 * H })).toEqual([on]);
  });

  it('never adds a fan-only step at or after the end (boundary)', () => {
    // The last period starts at T0 + 1 h; its fan step would fall exactly on the end.
    const steps = dutyCycle(on, { onMinutes: 20, periodMinutes: 60, fromMs: T0, toMs: T0 + H + 20 * 60_000 });
    expect(steps.map((s) => [(Date.parse(s.ts) - T0) / 60_000, s.hvacMode])).toEqual([
      [0, 'dry'],
      [20, 'fan_only'],
      [60, 'dry'],
    ]);
  });
});

describe('planner details', () => {
  const ladder = buildLadder({ season: 'cooling', goal: 'cool', profile, preferences, occupied: ['garage', 'living'], config: cfg });
  const input = (level: number, budgetW = 10_000, rh: Record<string, number> = {}) => ({
    ladderStep: rung(ladder, level),
    comfortC: preferences.comfortC.cooling,
    atMs: T0,
    profile,
    priority: preferences.roomPriority,
    budgetW,
    humidityByRoom: rh,
    config: cfg,
  });

  it('auto in the heating season heats; auto in the cooling season cools', () => {
    expect(rung(buildLadder({ season: 'heating', goal: 'auto', profile, preferences, occupied: [], config: cfg }), 0).preferredModes).toEqual(['heat']);
    expect(rung(buildLadder({ season: 'cooling', goal: 'auto', profile, preferences, occupied: [], config: cfg }), 0).preferredModes).toEqual(['cool']);
  });

  it('leaves out occupied rooms the home does not have, and orders by priority', () => {
    expect(rung(ladder, 0).roomIds).toEqual(['bedroom-1', 'living']);
  });

  it('dries only above the humidity threshold (boundary)', () => {
    expect(candidateSteps(input(1, 10_000, { 'bedroom-1': 60 }))[0]?.hvacMode).toBe('cool');
    expect(candidateSteps(input(1, 10_000, { 'bedroom-1': 60.1 }))[0]?.hvacMode).toBe('dry');
  });

  it('a waiting room is off with its fan off, even on a rung with fans', () => {
    const steps = candidateSteps(input(1, 0));
    expect(steps.map((s) => [s.hvacMode, s.fanOn])).toEqual([
      ['off', false],
      ['off', false],
    ]);
  });

  it('a room without the rung modes stays off', () => {
    const fanOnlyHome = HomeProfileSchema.parse({
      ...exampleHomeProfile(),
      rooms: exampleHomeProfile().rooms.map((r) => ({ ...r, hvacUnits: r.hvacUnits.map((u) => ({ ...u, modes: ['fan_only', 'off'] })) })),
    });
    expect(candidateSteps({ ...input(0), profile: fanOnlyHome })[0]?.hvacMode).toBe('off');
  });

  it('repeats the setting in force, not the first one, and never where a safe-room step already is', () => {
    const first = candidateSteps(input(0))[0];
    if (first === undefined) throw new Error('no step');
    const later = { ...first, ts: new Date(T0 + 90 * 60_000).toISOString(), hvacMode: 'dry' as const };
    const atTwo = { ...first, ts: new Date(T0 + 2 * H).toISOString(), setpointC: celsius(24) };
    const steps = withTargets([first, later, atTwo], { socMin: () => 50, fromMs: T0, toMs: T0 + 4 * H, safeRoomId: 'bedroom-1', config: cfg });
    const byTime = steps.map((s) => [(Date.parse(s.ts) - T0) / 60_000, s.hvacMode, s.setpointC]);
    expect(byTime).toEqual([
      [0, 'cool', 25],
      [90, 'dry', 25],
      [120, 'cool', 24],
      [60, 'cool', 25],
      [180, 'cool', 24],
    ]);
  });

  it('gives the last target the interval up to the end, or one interval when the end is closer', () => {
    const first = candidateSteps(input(0))[0];
    if (first === undefined) throw new Error('no step');
    const seen: [number, number][] = [];
    withTargets([first], { socMin: (a, b) => (seen.push([a - T0, b - T0]), 50), fromMs: T0, toMs: T0 + 30 * 60_000, safeRoomId: 'bedroom-1', config: cfg });
    expect(seen).toEqual([[0, H]]);
  });
});
