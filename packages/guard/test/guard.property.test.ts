import { HomeProfileSchema, pct, type HvacMode } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import { acLimitW, darkWindow, localHour, project, reserveFloorSocPct, reserveWh, weatherFromForecast } from '@cold-reserve/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runGuard } from '../src/index.js';
import { H, MIN, T0, config, hotNight, input, plan, snapshot, step } from './support.js';

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

// The guard invariants of plan §10.2 and brief F4, 10 000 cases each. Limits always come from the
// profile and the config, never from numbers written here. Boundary values are drawn explicitly.

const RUNS = { numRuns: runs(10_000) };
// About 2 ms per case on the old PC: 10 000 cases need more than the default 20 s.
const TIMEOUT = 180_000;
// A coarse projection keeps 10 000 cases fast; the physics is the same.
const fast = config((c) => ({ ...c, projection: { ...c.projection, stepMinutes: 30 } }));
const forecast = hotNight();
const ROOMS = ['bedroom-1', 'living', 'study'] as const;
const MODES: HvacMode[] = ['cool', 'dry', 'fan_only', 'off'];

const randomProfile = fc.record({ maxDischargeW: fc.constantFrom(1000, 2500, 5000), inverterMaxAcW: fc.constantFrom(3000, 6000) }).map((p) => {
  const base = exampleHomeProfile();
  return HomeProfileSchema.parse({ ...base, inverterMaxAcW: p.inverterMaxAcW, battery: { ...base.battery, maxDischargeW: p.maxDischargeW } });
});

const floorFor = (profile: ReturnType<typeof HomeProfileSchema.parse>) => {
  const dark = darkWindow({ forecast, fromMs: T0, pvPeakW: profile.pvPeakW, lossRatio: 0.14, essentialLoadW: fast.reserve.essentialLoadW });
  const hours = dark === undefined ? 0 : (dark.toMs - dark.fromMs) / H;
  const reserve = reserveWh({ essentialLoadW: fast.reserve.essentialLoadW, darkHours: hours, roundTripEff: profile.battery.roundTripEff, capWh: fast.reserve.capWh });
  return reserveFloorSocPct(profile.battery, reserve);
};

/** Random plans around the interesting edges: targets near the reserve floor, all rooms, all modes. */
const randomCase = fc
  .record({
    profile: randomProfile,
    socPct: fc.oneof(fc.constantFrom(10, 11, 35, 36, 100), fc.double({ min: 10, max: 100, noNaN: true })),
    gridAvailable: fc.boolean(),
    horizonH: fc.integer({ min: 1, max: 6 }),
    steps: fc.array(
      fc.record({
        roomId: fc.constantFrom(...ROOMS),
        mode: fc.constantFrom(...MODES),
        setpointC: fc.integer({ min: 16, max: 30 }),
        offsetMin: fc.integer({ min: 0, max: 300 }),
        targetDelta: fc.oneof(fc.constantFrom(0, -0.01, 0.01), fc.double({ min: -30, max: 60, noNaN: true })),
      }),
      { minLength: 1, maxLength: 5 },
    ),
  })
  .map((c) => {
    const floor = floorFor(c.profile);
    const steps = c.steps.map((s) =>
      step({ roomId: s.roomId, mode: s.mode, setpointC: s.setpointC, atMs: T0 + s.offsetMin * MIN, targetPct: Math.min(100, Math.max(0, floor + s.targetDelta)) }),
    );
    return { ...c, floor, guard: input({ profile: c.profile, config: fast, snapshot: snapshot({ socPct: c.socPct, gridAvailable: c.gridAvailable }), plan: plan(steps, T0 + c.horizonH * H) }) };
  });

describe('guard invariants (fast-check, 10 000 cases)', () => {
  it('no accepted plan violates storm_reserve: with the grid up, every target stays at or above the reserve floor', () => {
    fc.assert(
      fc.property(randomCase, (c) => {
        const v = runGuard(c.guard);
        if (!v.ok || !c.gridAvailable) return;
        for (const s of c.guard.plan.steps) expect(s.batteryTargetSocPct).toBeGreaterThanOrEqual(c.floor);
      }),
      RUNS,
    );
  }, TIMEOUT);

  it('no accepted plan exceeds the inverter or the battery limits at any step', () => {
    fc.assert(
      fc.property(randomCase, (c) => {
        const v = runGuard(c.guard);
        if (!v.ok) return;
        const { profile } = c;
        // An independent projection with the hardware floor: the most the battery could ever be asked for.
        const points = project({
          profile,
          params: c.guard.model,
          start: {
            ms: T0,
            socPct: pct(c.socPct),
            rooms: c.guard.snapshot.rooms.map((r) => ({ id: r.id, tempC: r.tempC, humidityPct: r.humidityPct ?? pct(50) })),
            occupants: { 'bedroom-1': ['grandpa'] },
          },
          weatherAt: weatherFromForecast(forecast),
          controlAt: (ms) =>
            ROOMS.map((id) => {
              const s = c.guard.plan.steps.filter((x) => x.roomId === id && Date.parse(x.ts) <= ms).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).at(-1);
              return s === undefined ? { id, fanOn: false } : { id, hvac: { mode: s.hvacMode, setpointC: s.setpointC }, fanOn: s.fanOn };
            }),
          gridAvailable: c.gridAvailable,
          dischargeFloorPct: pct(profile.battery.minSocHwPct),
          baseLoadAt: (ms) => fast.projection.baseLoadWByLocalHour[Math.floor(localHour(ms, profile.location.tz)) % 24] ?? 0,
          toMs: T0 + c.horizonH * H,
          stepMinutes: fast.projection.stepMinutes,
        });
        for (const p of points) {
          expect(p.flows.loadW).toBeLessThanOrEqual(acLimitW(profile, c.gridAvailable) + 1e-6);
          // Off grid the battery must carry whatever PV does not: that demand stays within its rating.
          if (!c.gridAvailable) expect(p.flows.loadW - Math.min(p.flows.pvW, p.flows.loadW)).toBeLessThanOrEqual(profile.battery.maxDischargeW + 1e-6);
        }
      }),
      RUNS,
    );
  }, TIMEOUT);

  it('the guard never changes its inputs (a rejected plan changes nothing) and is deterministic', () => {
    fc.assert(
      fc.property(randomCase, (c) => {
        const before = structuredClone(c.guard);
        const a = runGuard(c.guard);
        expect(c.guard).toEqual(before);
        expect(runGuard(c.guard)).toEqual(a);
      }),
      { numRuns: runs(2_000) },
    );
  }, TIMEOUT);

  it('always returns the five guarantees, and ok means all of them hold and the night is not unmet', () => {
    fc.assert(
      fc.property(randomCase, (c) => {
        const v = runGuard(c.guard);
        expect(v.guarantees).toHaveLength(5);
        expect(v.ok).toBe(v.guarantees.every((x) => x.ok) && v.nightRecovery?.status !== 'unmet');
      }),
      RUNS,
    );
  }, TIMEOUT);

  it('night recovery hours never decrease with more energy in the battery (off grid)', () => {
    const night = fc.record({
      a: fc.oneof(fc.constantFrom(10, 11, 100), fc.double({ min: 10, max: 100, noNaN: true })),
      b: fc.oneof(fc.constantFrom(10, 11, 100), fc.double({ min: 10, max: 100, noNaN: true })),
      setpointC: fc.integer({ min: 20, max: 28 }),
      mode: fc.constantFrom<HvacMode>('cool', 'dry'),
    });
    const nightConfig = config((c) => ({ ...c, projection: { ...c.projection, stepMinutes: 30 } }));
    fc.assert(
      fc.property(night, ({ a, b, setpointC, mode }) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const run = (soc: number) =>
          runGuard(input({ config: nightConfig, snapshot: snapshot({ socPct: soc, gridAvailable: false }), plan: plan([step({ mode, setpointC, targetPct: 10 })]) })).nightRecovery;
        const nLo = run(lo);
        const nHi = run(hi);
        expect(nHi?.achievedHours ?? 0).toBeGreaterThanOrEqual((nLo?.achievedHours ?? 0) - 1e-9);
        if (nLo?.bestAchievableHours !== undefined && nHi?.bestAchievableHours !== undefined) {
          expect(nHi.bestAchievableHours).toBeGreaterThanOrEqual(nLo.bestAchievableHours - 1e-9);
        }
      }),
      { numRuns: runs(1_000) },
    );
  }, TIMEOUT);

  it('never a fake pass: met means the hours and the heat budget really hold; infeasible always carries its warning', () => {
    fc.assert(
      fc.property(randomCase, (c) => {
        const v = runGuard(c.guard);
        const n = v.nightRecovery;
        if (n === undefined) return;
        if (n.status === 'met') {
          expect(n.achievedHours).toBeGreaterThanOrEqual(n.requiredHours - 1e-9);
          expect(n.heatIndexDegreeHoursAbove26_7).toBeLessThanOrEqual(n.budgetDegreeHours + 1e-9);
        }
        const codes: readonly string[] = v.warnings.map((w) => w.code);
        expect(codes.includes('night_recovery_infeasible')).toBe(n.status === 'infeasible');
      }),
      RUNS,
    );
  }, TIMEOUT);
});
