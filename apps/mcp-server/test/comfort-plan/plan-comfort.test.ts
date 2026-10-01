import { GUARANTEE_IDS, PlanIdSchema, PlanSchema, PreferencesSchema, celsius, err, pct, toolError, type Forecast } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { guardFrame, loadInputs, planComfort } from '../../src/modules/comfort-plan/plan-comfort.js';
import { REAL, preferences, world } from './support.js';

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

describe('plan_comfort (two-phase: propose)', () => {
  it('proposes the most comfortable plan the guard accepts, saved as proposed with its expiry', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const plan = PlanSchema.parse(r.value);
    expect(plan).toMatchObject({ id: 'plan_test_0001', homeId: 'demo', status: 'proposed', goal: 'cool', advisoryOnly: false });
    expect(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt)).toBe(w.deps.config.planTtlMinutes * 60_000);
    expect(plan.createdAt).toBe(new Date(w.clock.now()).toISOString());
    expect(plan.guarantees.map((g) => g.id)).toEqual([...GUARANTEE_IDS]);
    expect(plan.guarantees.every((g) => g.ok)).toBe(true);
    expect(plan.nightRecovery?.status).not.toBe('unmet');
    expect(plan.reserveFloorSocPct).toBeGreaterThan(w.profile.battery.minSocHwPct);
    expect(plan.gridAvailable).toBe(true);
    const saved = await w.store.getPlan(plan.id);
    expect(saved.ok && saved.value).toEqual(plan);
  });

  it('adds the counterfactual: without the plan the safe room gets hotter', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const c = r.value.counterfactual;
    expect(c?.roomId).toBe('bedroom-1');
    expect(c?.scenarios.noPlan.peakTempC).toBeGreaterThan(c?.scenarios.plan.peakTempC ?? Infinity);
  });

  it('keeps only the ladder from the chosen level down', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const levels = r.value.ladder.map((s) => s.level);
    expect(levels.at(-1)).toBe('essential');
    expect(new Set(r.value.steps.map((s) => s.level))).toEqual(new Set([levels[0]]));
  });

  it('checks exactly what the model proposed: the guard says no, with the nearest allowed value; nothing is saved', async () => {
    const w = world('storm-blackout', 3);
    const r = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(18), roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] }, w.ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.category).toBe('guard_rejection');
    expect(r.error.details?.nearestAllowed).toBeDefined();
    const missing = await w.store.getPlan(PlanIdSchema.parse('plan_test_0001'));
    expect(missing.ok).toBe(false);
    const rejections = await w.store.listGuardRejections();
    expect(rejections.ok && rejections.value).toHaveLength(1);
  });

  it('refuses rooms the home does not have', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool', roomIds: ['garage'] }, w.ctx);
    expect(!r.ok && r.error).toMatchObject({ code: 'unknown_room', details: { roomId: 'garage' } });
  });

  it('a home the client is not linked to is not found', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, { ...w.ctx, homeId: REAL });
    expect(!r.ok && r.error.code).toBe('home_not_found');
  });

  it('on a read-only home (the real one) the plan is advice only', async () => {
    const w = world('heatwave', 14, { homeId: REAL, readOnly: true });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    expect(r.ok && r.value.advisoryOnly).toBe(true);
  });

  it('passes a failing data source through, unchanged', async () => {
    const w = world('heatwave', 14);
    const home = w.deps.homes(w.ctx.homeId);
    if (home === undefined) throw new Error('no home');
    const down = { ...w.deps, homes: () => ({ ...home, source: { snapshot: () => Promise.resolve(err(toolError('home_data_stale', 'Stale.'))) } }) };
    const r = await planComfort(down, { goal: 'cool' }, w.ctx);
    expect(!r.ok && r.error.code).toBe('home_data_stale');
  });

  it('uses the elderly night threshold when an elderly person is in the safe room', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    expect(r.ok && r.value.nightRecovery?.mode).toBe('elderly');
    const young = world('heatwave', 14, { snapshot: (s) => ({ ...s, rooms: s.rooms.map((x) => ({ ...x, occupants: [] })) }) });
    const r2 = await planComfort(young.deps, { goal: 'cool' }, young.ctx);
    expect(r2.ok && r2.value.nightRecovery?.mode).toBe('standard');
  });

  it('on a humid heatwave night without an elderly person, alternates dry and cool to keep the humidity in band', async () => {
    const w = world('heatwave', 14, { snapshot: (s) => ({ ...s, rooms: s.rooms.map((x) => ({ ...x, occupants: [] })) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    expect(r.value.guarantees.find((g) => g.id === 'safe_room_comfort')?.ok).toBe(true);
    const n = r.value.nightRecovery;
    const night = r.value.steps.filter((s) => s.roomId === 'bedroom-1' && s.ts >= (n?.window.start ?? '') && s.ts < (n?.window.end ?? ''));
    expect(new Set(night.map((s) => s.hvacMode))).toEqual(new Set(['dry', 'cool']));
  });

  it('on a humid clear-day evening, dries before the night as well: the mode follows the humidity until the horizon', async () => {
    const w = world('clear-day', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    const evening = r.value.steps.filter((s) => s.roomId === 'bedroom-1' && s.ts < (r.value.nightRecovery?.window.start ?? ''));
    expect(evening.some((s) => s.hvacMode === 'dry')).toBe(true);
  });

  it('leaves a plan the model proposed as it is: no mode is changed for humidity', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(26), roomIds: ['bedroom-1'] }, w.ctx);
    expect(r.ok ? r.value.steps.filter((s) => s.roomId === 'bedroom-1').map((s) => s.hvacMode) : r.error.code).not.toContain('dry');
  });

  it('property: whoever is home, however humid the safe room and whatever humidity limits the person set, the planner never gives up on humidity', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 12, max: 20 }),
        fc.boolean(),
        fc.integer({ min: 40, max: 58 }),
        // A minimum above 40 % cannot be held on a dry heatwave afternoon with only cool and dry (no
        // humidifier): every plan is refused there, the case of the storm last resort. The maximum is the
        // edge the planner's band must follow.
        fc.integer({ min: 35, max: 40 }),
        fc.integer({ min: 50, max: 65 }),
        async (atH, elderly, rh, minPct, maxPct) => {
          const prefs = PreferencesSchema.parse({ ...preferences, safety: { ...preferences.safety, humidity: { minPct, maxPct } } });
          const w = world('heatwave', atH, {
            preferences: prefs,
            snapshot: (s) => ({
              ...s,
              rooms: s.rooms.map((x) => ({ ...x, occupants: elderly ? x.occupants : [], ...(x.id === 'bedroom-1' ? { humidityPct: pct(Math.min(Math.max(rh, minPct), maxPct)) } : {}) })),
            }),
          });
          const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
          expect(r.ok || r.error.message).toBe(true);
        },
      ),
      // Each case plans a whole heatwave afternoon and night (about a second): fewer cases than the core properties.
      { numRuns: runs(40) },
    );
  }, 300_000);

  it('in the storm, the full battery keeps the safe room at comfort until the recharge, with the night recovered', async () => {
    // Humidity, not energy, used to force the paced essential plan here: with the mode following the
    // humidity, serving the safe room alone at comfort lasts until the 08:00 recharge.
    const w = world('storm-blackout', 3);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    expect(r.value.guarantees.every((g) => g.ok)).toBe(true);
    expect(r.value.guarantees.find((g) => g.id === 'pacing_on_track')?.reason).toMatch(/lasts until the next recharge/);
    expect(r.value.steps[0]?.level).toBe('comfort');
    expect(new Set(r.value.steps.map((s) => s.roomId))).toEqual(new Set(['bedroom-1']));
    expect(r.value.nightRecovery?.status).toBe('met');
  });
});

describe('the guard frame (season and night mode), shared by propose and apply', () => {
  const coldSpell = (f: Forecast): Forecast => ({ ...f, hourly: f.hourly.map((h) => ({ ...h, tempOutC: celsius(12), humidityOutPct: pct(40) })) });

  async function frameIn(w: ReturnType<typeof world>, goal: 'cool' | 'heat' | 'dry' | 'auto') {
    const inputs = await loadInputs(w.deps, w.ctx);
    if (!inputs.ok) throw new Error(inputs.error.message);
    return guardFrame(w.deps, goal, inputs.value);
  }

  it('takes the season from the goal, and for auto from the forecast', async () => {
    const hot = world('heatwave', 14);
    const cold = world('clear-day', 6, { forecast: coldSpell });
    expect((await frameIn(hot, 'cool')).season).toBe('cooling');
    expect((await frameIn(hot, 'heat')).season).toBe('heating');
    expect((await frameIn(hot, 'auto')).season).toBe('cooling');
    expect((await frameIn(cold, 'auto')).season).toBe('heating');
  });

  it('uses the elderly night mode when an elderly person is in the safe room right now', async () => {
    expect((await frameIn(world('heatwave', 14), 'cool')).nightRecoveryMode).toBe('elderly');
    const empty = world('heatwave', 14, { snapshot: (s) => ({ ...s, rooms: s.rooms.map((x) => ({ ...x, occupants: [] })) }) });
    expect((await frameIn(empty, 'cool')).nightRecoveryMode).toBe('standard');
  });
});
