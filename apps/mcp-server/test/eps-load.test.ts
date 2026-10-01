import { HomeProfileSchema, pct, type HomeProfile } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { projectFrom } from '@cold-reserve/guard';
import { SimulatorSource, builtInScenario, defaultSimParams, demoProfile } from '@cold-reserve/source-simulator';
import { describe, expect, it } from 'vitest';
import { warnMissingEpsLoad } from '../src/app.js';
import type { LogEntry } from '../src/handler.js';
import { safeRoomStatus } from '../src/modules/storm-mode/tools.js';
import { guardConfig } from './comfort-plan/support.js';
import { expectedSafeHours } from './storm-mode/expected.js';
import { preferences, stormConfig, world } from './storm-mode/support.js';

// Off grid only the EPS circuits are powered. What they draw besides the HVAC is one number, the home
// profile's `epsBaseLoadW` (approved in #19): the simulator, the guard's projection and the storm safe
// hours all read it.

const H = 3_600_000;
const withEps = (w: number) => (p: HomeProfile) => HomeProfileSchema.parse({ ...p, epsBaseLoadW: w });

describe('the EPS load, one number for every consumer', () => {
  it('the simulator, the projection and the safe hours read the same EPS load from the home profile', async () => {
    // Storm hour 4: the grid is down. The same scenario with 150 W and with 333 W on the EPS circuits.
    const w = world(4, { profile: withEps(333) });

    // The storm safe hours count the profile's 333 W.
    const status = await safeRoomStatus(w.deps, w.ctx);
    if (!status.ok) throw new Error(status.error.message);
    expect(w.profile.epsBaseLoadW).toBe(333);
    expect(status.value.safeHours).toBeCloseTo(expectedSafeHours({ snapshot: w.snapshot(), forecast: w.forecast(), profile: w.profile, preferences, config: stormConfig() }), 6);

    // The simulator draws 183 W more than with 150 W (the same seed: the same load noise, at most 5 %).
    const scenario = builtInScenario('storm-blackout');
    const at = Date.parse(scenario.startAt) + 4 * H;
    const loadW = (p: HomeProfile) => new SimulatorSource({ profile: p, scenario, params: defaultSimParams(), clock: fixedClock(at) }).snapshotAt(at).loadW;
    const extra = loadW(withEps(333)(demoProfile())) - loadW(demoProfile());
    expect(extra).toBeGreaterThan(183 * 0.95);
    expect(extra).toBeLessThan(183 * 1.05);

    // The guard's projection, with nothing running, draws exactly the profile's 333 W.
    const snapshot = w.snapshot();
    const points = projectFrom(
      { plan: { horizonAt: snapshot.ts, steps: [], ladder: [] }, snapshot, forecast: w.forecast(), profile: w.profile, preferences, season: 'cooling', model: defaultSimParams(), config: guardConfig(), nightRecoveryMode: 'standard' },
      () => [],
      { toMs: Date.parse(snapshot.ts) + H, dischargeFloorPct: pct(10) },
    );
    expect(snapshot.gridAvailable).toBe(false);
    expect(points[0]?.flows.loadW).toBeCloseTo(333, 9);
  });

  it('logs a warning at start-up for each home profile without its EPS load: its storm calculations will refuse', () => {
    const logged: LogEntry[] = [];
    const bare = HomeProfileSchema.parse(Object.fromEntries(Object.entries(demoProfile()).filter(([k]) => k !== 'epsBaseLoadW')));
    warnMissingEpsLoad([demoProfile(), bare], { log: (e) => logged.push(e) });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'warn', code: 'missing_eps_load', category: 'internal', homeId: 'demo' });
    expect(logged[0]?.message).toContain('storm calculations refuse');
  });
});
