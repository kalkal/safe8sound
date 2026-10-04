import { GUARANTEE_IDS, HomeIdSchema, HomeProfileSchema, LAST_RESORT_ACTIONS, PlanIdSchema, PlanSchema, PreferencesSchema, celsius, err, pct, toolError, kilowatt, watt, type Forecast, type HomeProfile } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/modules/comfort-plan/apply-plan.js';
import { holdSafeRoom } from '@cold-reserve/guard';
import { comfortPlanModule } from '../../src/modules/comfort-plan/index.js';
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

  it('a refused proposal comes back as the plan that holds: saved, applicable, with a short note of the refusal (#202)', async () => {
    const w = world('storm-blackout', 3);
    const r = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(18), roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] }, w.ctx);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    const plan = PlanSchema.parse(r.value);
    // The planner's own plan for the same moment, as plan_comfort with only the goal gives it.
    const own = await planComfort(world('storm-blackout', 3).deps, { goal: 'cool' }, w.ctx);
    if (!own.ok) throw new Error(own.error.message);
    expect(plan.steps).toEqual(own.value.steps);
    expect(plan.guarantees.every((g) => g.ok)).toBe(true);
    expect(plan.lastResort).toBeUndefined();
    expect(plan.refusedProposal?.code).toMatch(/_(violated|exceeded|off_track|unmet)$/);
    expect(plan.refusedProposal?.message).toMatch(/Nearest allowed/);
    // Saved and applicable: the person can apply it in one step.
    const saved = await w.store.getPlan(plan.id);
    expect(saved.ok && saved.value.status).toBe('proposed');
    const applied = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(applied.ok && applied.value.plan.status).toBe('applied');
    // The guard's no to the proposal stays in the audit trail.
    const rejections = await w.store.listGuardRejections();
    expect(rejections.ok && rejections.value).toHaveLength(1);
  });

  it('checks exactly what the model proposed: when nothing holds, the guard says no, with the nearest allowed value; nothing is saved', async () => {
    const w = world('storm-blackout', 3, { snapshot: (s) => ({ ...s, batterySocPct: pct(30) }) });
    const r = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(18), roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] }, w.ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.category).toBe('guard_rejection');
    expect(r.error.details?.nearestAllowed).toBeDefined();
    // The whole verdict rides along for the REJECTED receipt (#186): five rows, the failing one among them.
    expect(r.error.details?.guarantees?.map((g) => g.id)).toEqual([...GUARANTEE_IDS]);
    expect(r.error.details?.guarantees?.find((g) => g.id === r.error.details?.guarantee)?.ok).toBe(false);
    const missing = await w.store.getPlan(PlanIdSchema.parse('plan_test_0001'));
    expect(missing.ok).toBe(false);
    const rejections = await w.store.listGuardRejections();
    expect(rejections.ok && rejections.value).toHaveLength(1);
  });

  it('a refusal says where its data came from; on a sandbox it carries neither the demo# id nor realHome (#198 review)', async () => {
    const sandbox = HomeIdSchema.parse('demo#0123456789abcdef');
    const w = world('storm-blackout', 3, { homeId: sandbox, snapshot: (s) => ({ ...s, batterySocPct: pct(30) }) });
    const r = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(18), roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] }, { ...w.ctx, homeId: sandbox });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.error.details?.origin).toMatchObject({ energy: 'simulated', rooms: 'simulated', weather: 'simulated' });
    expect(r.error.details?.realHome).toBeUndefined();
    expect(JSON.stringify(r.error)).not.toContain('demo#');
  });

  it('a refusal on the real home says so, for the "simulated data" notice of the receipt', async () => {
    const w = world('storm-blackout', 3, { homeId: REAL, readOnly: true, snapshot: (s) => ({ ...s, batterySocPct: pct(30) }) });
    const r = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(18), roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] }, w.ctx);
    if (r.ok) throw new Error('expected a refusal');
    expect(r.error.details?.realHome).toBe(true);
  });

  it('tells the model that a refused proposal comes back as the plan that holds (#202)', () => {
    const tool = comfortPlanModule(world('heatwave', 14).deps).tools.find((t) => t.name === 'plan_comfort');
    expect(tool?.description).toContain('If the guard refuses your setpoint or rooms, the answer is the plan that holds instead, ready to apply, with a note of the refusal.');
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
    const young = world('heatwave', 14, { snapshot: (s) => ({ ...s, rooms: s.rooms.map((x) => ({ ...x, occupants: x.occupants.length > 0 ? ['daughter', 'son'] : [] })) }) });
    const r2 = await planComfort(young.deps, { goal: 'cool' }, young.ctx);
    expect(r2.ok && r2.value.nightRecovery?.mode).toBe('standard');
  });

  it('on a humid heatwave night without an elderly person, alternates dry and cool to keep the humidity in band', async () => {
    const w = world('heatwave', 14, { snapshot: (s) => ({ ...s, rooms: s.rooms.map((x) => ({ ...x, occupants: x.occupants.length > 0 ? ['daughter', 'son'] : [] })) }) });
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

  it("on a dry afternoon under the person's humidity minimum, proposes cooling with a warning, never drying the room further", async () => {
    // 35 % in the bedroom, a 42 % minimum: no plan can raise the humidity, so that is a warning (#107).
    const prefs = PreferencesSchema.parse({ ...preferences, safety: { ...preferences.safety, humidity: { minPct: 42, maxPct: 60 } } });
    const w = world('heatwave', 12, { preferences: prefs, snapshot: (s) => ({ ...s, rooms: s.rooms.map((x) => (x.id === 'bedroom-1' ? { ...x, humidityPct: pct(35) } : x)) }) });
    // Without the solar surplus (#203): cooling the room a degree further raises its humidity past the minimum
    // within the hour, and the dry-air case this test pins would be gone.
    const planner = w.deps.config.planner;
    const deps = { ...w.deps, config: { ...w.deps.config, planner: { ...planner, surplus: { ...planner.surplus, minExportW: 10_000 } } } };
    const r = await planComfort(deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    expect(r.value.warnings?.some((x) => x.code === 'dry_air')).toBe(true);
    expect(r.value.steps.filter((s) => s.roomId === 'bedroom-1')[0]?.hvacMode).toBe('cool');
  });

  it('checks a plan the model proposed as it is: no mode is changed for humidity; refused, the answer is the plan that holds (#202)', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(26), roomIds: ['bedroom-1'] }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    // Either the proposal held exactly as proposed (cool, never switched to dry), or the guard refused it and the
    // planner's own plan answers, with the refusal noted: never a silently edited proposal.
    if (r.value.refusedProposal === undefined) expect(r.value.steps.filter((s) => s.roomId === 'bedroom-1').map((s) => s.hvacMode)).not.toContain('dry');
    else expect(r.value.guarantees.every((g) => g.ok)).toBe(true);
  });

  it('property: whoever is home, however humid the safe room and whatever humidity limits the person set, the planner never gives up on humidity', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 12, max: 20 }),
        fc.boolean(),
        fc.integer({ min: 40, max: 58 }),
        // A minimum above the dry afternoon's humidity cannot be held with only cool and dry (no humidifier):
        // since #107 that is a warning, not a refusal. The maximum is the edge the planner's band must follow.
        fc.integer({ min: 35, max: 45 }),
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

describe('last resort (approved in #19: proposal only)', () => {
  const HARD = ['storm_reserve', 'inverter_limit', 'battery_power'];
  const stormAt = (soc: number) => world('storm-blackout', 3, { snapshot: (s) => ({ ...s, batterySocPct: pct(soc) }) });

  it('in a storm with a 35 % battery no plan holds until the recharge: proposes the safest one, with until when and why', async () => {
    const w = stormAt(35);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    const p = PlanSchema.parse(r.value);
    expect(p.lastResort).toBeDefined();
    expect(p.guarantees.filter((g) => HARD.includes(g.id)).every((g) => g.ok)).toBe(true);
    expect(p.guarantees.some((g) => !g.ok)).toBe(true);
    expect(p.lastResort?.safeHours).toBeGreaterThan(0);
    // The time as the person says it, in the home's zone (the guard's reasons use local time too).
    expect(p.warnings?.find((x) => x.code === 'last_resort_plan')?.message).toMatch(
      /^No plan keeps the Bedroom within its limits until the next recharge: safe for about [\d.]+ hours, until \d{1,2}:\d\d (AM|PM); then /,
    );
    expect(p.lastResort?.safeUntil).toMatch(/\+02:00$/);
    // A last resort names a real limit inside the horizon, never a battery that does not run out.
    expect(Date.parse(p.lastResort?.safeUntil ?? '')).toBeLessThan(Date.parse(p.horizonAt));
    const saved = await w.store.getPlan(p.id);
    expect(saved.ok && saved.value.status).toBe('proposed');
  });

  it('the last resort IS the hold of the safe room (#24, decision A): the safe room alone at essential, every other room off', async () => {
    const w = stormAt(30);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const p = PlanSchema.parse(r.value);
    expect(p.lastResort).toBeDefined();
    const safe = p.steps.filter((s) => s.roomId === 'bedroom-1');
    const others = p.steps.filter((s) => s.roomId !== 'bedroom-1');
    expect(safe.length).toBeGreaterThan(0);
    expect(safe.every((s) => s.level === 'essential' && !s.fanOn && (s.hvacMode === 'cool' || s.hvacMode === 'dry'))).toBe(true);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((s) => s.hvacMode === 'off' && !s.fanOn)).toBe(true);
    // A safe-room-only essential plan pre-authorizes no other step: its ladder is essential alone.
    expect(p.ladder.map((r) => r.level)).toEqual(['essential']);
    // The log says where the last resort came from (#182 review).
    expect(w.logger.lines.find((l) => l.details?.['event'] === 'last_resort_proposed')?.details?.['source']).toBe('hold');
    // The hard limits stay hard: the guard checked the hold like any plan.
    expect(p.guarantees.filter((g) => HARD.includes(g.id)).every((g) => g.ok)).toBe(true);
    // Its safe-until is the guard's hold of the safe room: the time the storm card names.
    const snap = await w.deps.homes(w.ctx.homeId)?.source.snapshot();
    if (!snap?.ok) throw new Error('no snapshot');
    const forecast = w.deps.homes(w.ctx.homeId)?.forecast();
    if (forecast === undefined) throw new Error('no forecast');
    const held = holdSafeRoom(
      { snapshot: snap.value, forecast, profile: w.profile, preferences, ...guardFrame(w.deps, 'cool', { snapshot: snap.value, forecast, preferences }), model: w.deps.model, config: w.deps.guard },
      { toMs: Date.parse(p.horizonAt), dischargeFloorPct: pct(w.profile.battery.minSocHwPct), humidityBand: w.deps.config.planner.humidityBand, marginK: w.deps.config.planner.essentialMarginK },
    );
    if (!held.ok || held.value.safeUntil === undefined) throw new Error('the hold should end inside the horizon');
    expect(Date.parse(p.lastResort?.safeUntil ?? '')).toBe(Math.floor(held.value.safeUntil.ms / 1000) * 1000);
    expect(p.lastResort?.limitedBy).toBe(held.value.safeUntil.limitedBy);
  });

  it('when the hold cannot be projected, a warn line with its code says so, and the candidates answer: here a refusal (#182 review)', async () => {
    const w = world('storm-blackout', 3, { snapshot: (s) => ({ ...s, batterySocPct: pct(30), rooms: s.rooms.filter((x) => x.id !== 'bedroom-1') }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    const warn = w.logger.lines.find((l) => l.details?.['event'] === 'last_resort_hold_failed');
    expect(warn).toMatchObject({ level: 'warn', code: 'unknown_room', category: 'validation', correlationId: 'test-correlation' });
    const proposed = w.logger.lines.find((l) => l.details?.['event'] === 'last_resort_proposed');
    // Without the safe room's reading no candidate names a safe-until either: no last resort, the guard's refusal.
    expect(r.ok ? undefined : r.error.code).toBe('safe_room_comfort_violated');
    expect(proposed).toBeUndefined();
  });

  it('the safe hours start now and end at the time given', async () => {
    const w = stormAt(35);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const snap = await w.deps.homes(w.ctx.homeId)?.source.snapshot();
    if (!snap?.ok) throw new Error('no snapshot');
    const hours = (Date.parse(r.value.lastResort?.safeUntil ?? '') - Date.parse(snap.value.ts)) / 3_600_000;
    expect(r.value.lastResort?.safeHours).toBeCloseTo(hours, 2);
  });

  describe('the night limit wins over a higher safety maximum (#160, d-limiti-preferenze)', () => {
    // Two adults in the safe room, no elderly person: the standard 26 °C night threshold.
    const noElderly = (soc: number, prefs = preferences) =>
      world('storm-blackout', 3, { preferences: prefs, snapshot: (s) => ({ ...s, batterySocPct: pct(soc), rooms: s.rooms.map((x) => ({ ...x, occupants: x.occupants.length > 0 ? ['daughter', 'son'] : [] })) }) });
    const lastResortOf = async (w: ReturnType<typeof world>) => {
      const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
      if (!r.ok) throw new Error(r.error.message);
      const lr = r.value.lastResort;
      if (lr === undefined) throw new Error('no last resort');
      return { plan: r.value, lr, warning: r.value.warnings?.find((x) => x.code === 'last_resort_plan')?.message ?? '' };
    };

    it('at 30 % the battery ends the safe hours at night: the window names the 26 °C night limit, and the zero-energy actions', async () => {
      const { lr } = await lastResortOf(noElderly(30));
      expect(lr.limitedBy).toBe('battery');
      expect(lr.loweredLimitC).toBeUndefined();
      expect(lr.comfortLimitC).toBe(26);
      expect(lr.worstC).toBeGreaterThan(26);
      expect(lr.worstAt).toMatch(/\+02:00$/);
      expect(Date.parse(lr.worstAt ?? '')).toBeGreaterThanOrEqual(Date.parse(lr.safeUntil));
      expect(lr.actions).toEqual([...LAST_RESORT_ACTIONS]);
    });

    it('a plan that fails only the pace is a refusal, not a last resort: nobody in the safe room, the room stays inside its limits', async () => {
      const wide = PreferencesSchema.parse({ ...preferences, safety: { ...preferences.safety, humidity: { minPct: 30, maxPct: 80 } } });
      const empty = world('storm-blackout', 3, { preferences: wide, snapshot: (s) => ({ ...s, batterySocPct: pct(30), rooms: s.rooms.map((x) => ({ ...x, occupants: [] })) }) });
      const r = await planComfort(empty.deps, { goal: 'cool' }, empty.ctx);
      expect(!r.ok && r.error.code).toBe('pacing_off_track');
    });

    it('a safety maximum of 30 °C still says 26 °C at night', async () => {
      const hot = PreferencesSchema.parse({ ...preferences, safety: { ...preferences.safety, cooling: { maxC: 30 } } });
      const { lr } = await lastResortOf(noElderly(30, hot));
      expect(lr.comfortLimitC).toBe(26);
    });

    it('with an elderly person the hold pre-cools to the 24 °C night limit: safe past 22:00, and the window says how far above it the room goes', async () => {
      const { lr } = await lastResortOf(stormAt(30));
      // Without pre-cooling the 24 °C night limit ended his hours at 22:00 with charge left.
      expect(Date.parse(lr.safeUntil)).toBeGreaterThan(Date.parse('2026-07-17T22:00:00+02:00'));
      // Pinned: pre-cooled, his room holds the 24 °C night limit until the battery runs out at 00:40.
      expect({ safeUntil: lr.safeUntil, limitedBy: lr.limitedBy }).toEqual({ safeUntil: '2026-07-18T00:40:00+02:00', limitedBy: 'battery' });
      expect(lr.comfortLimitC).toBe(24);
      expect(lr.worstC).toBeGreaterThan(24);
      expect(Date.parse(lr.worstAt ?? '')).toBeGreaterThanOrEqual(Date.parse(lr.safeUntil));
    });
  });

  it('off grid on a home without its EPS load, refuses to plan rather than assume one (#107)', async () => {
    const w = stormAt(87.5);
    const home = w.deps.homes(w.ctx.homeId);
    if (home === undefined) throw new Error('no home');
    const bare = HomeProfileSchema.parse(Object.fromEntries(Object.entries(home.profile).filter(([k]) => k !== 'epsBaseLoadW')));
    const deps = { ...w.deps, homes: () => ({ ...home, profile: bare }) };
    const r = await planComfort(deps, { goal: 'cool' }, w.ctx);
    expect(!r.ok && r.error.code).toBe('missing_eps_load');
  });

  it('is not applied by a plain apply_plan: the first yes only returns a token (#160)', async () => {
    const w = stormAt(35);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const applied = await applyPlan(w.deps, { planId: r.value.id }, w.ctx);
    expect(applied.ok && applied.value.confirmation?.token).toMatch(/^lr_/);
    expect(applied.ok && applied.value.plan.status).toBe('proposed');
  });

  it('property: in a storm, whatever the battery, there is always a plan, or a refusal on a hard limit', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 15, max: 100 }), async (soc) => {
        const w = stormAt(soc);
        const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
        if (r.ok) return;
        expect(['storm_reserve_violated', 'inverter_limit_exceeded', 'battery_power_exceeded']).toContain(r.error.code);
      }),
      // Each case plans a whole storm night (about a second): fewer cases than the core properties.
      { numRuns: runs(30) },
    );
  }, 300_000);
});

/** An inverter limit the plain plan fits in and the plan with the surplus does not (found by probing the hot day). */
const SURPLUS_TIGHT_INVERTER_W = 5_000;

describe('solar surplus at home instead of on the grid (#203)', () => {
  // The hot day at 16:00, battery full: today's plan would export about 9.5 kWh between 16:00 and 20:00.
  const sunny = () => world('heatwave', 14);
  const planned = async (w: ReturnType<typeof world>, input: Parameters<typeof planComfort>[1] = { goal: 'cool' }) => {
    const r = await planComfort(w.deps, input, w.ctx);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    return PlanSchema.parse(r.value);
  };

  it('sends the surplus to the safe room first, then the rooms used tonight or now, the hottest first, and keeps the kWh at home', async () => {
    const p = await planned(sunny());
    const s = p.surplus;
    if (s === undefined) throw new Error('no surplus');
    expect(s.rooms[0]).toMatchObject({ roomId: 'bedroom-1', reason: 'safe_room' });
    expect(s.rooms.slice(1).map((r) => r.reason).every((r) => r === 'occupied' || r === 'occupied_tonight')).toBe(true);
    const above = s.rooms.slice(1).map((r) => r.aboveTargetK);
    expect(above).toEqual([...above].sort((a, b) => b - a));
    expect(s.rooms.map((r) => r.roomId)).not.toContain('living');
    expect(s.keptKWh).toBeGreaterThan(0);
    expect(s.from).toMatch(/\+02:00$/);
    expect(Date.parse(s.to)).toBeGreaterThan(Date.parse(s.from));
    expect(p.guarantees.every((g) => g.ok)).toBe(true);
  });

  it('never colder than the household asked: comfort minus the offset, and less in the safe room with an elderly person', async () => {
    const p = await planned(sunny());
    const cfg = sunny().deps.config.planner.surplus;
    const [safe, ...others] = p.surplus?.rooms ?? [];
    expect(safe?.setpointC).toBe(Math.max(preferences.comfortC.cooling - cfg.elderlyOffsetK, preferences.safety.heating.minC + 1));
    for (const r of others) expect(r.setpointC).toBe(Math.max(preferences.comfortC.cooling - cfg.offsetK, preferences.safety.heating.minC + 1));
    // The plan itself cools those rooms at those setpoints from the start of the window.
    for (const r of p.surplus?.rooms ?? []) {
      expect(p.steps.some((st) => st.roomId === r.roomId && st.ts === new Date(Date.parse(p.surplus?.from ?? '')).toISOString() && st.setpointC === r.setpointC && st.hvacMode !== 'off')).toBe(true);
    }
  });

  it('at 60 % the charge-limit export before the battery is full is no surplus: the window starts once it is (#226 review)', async () => {
    // PV above the 5 kW maximum charge exports at 60 % too; that energy the night needs, so it stays out.
    const full = await planned(sunny());
    const p = await planned(world('heatwave', 14, { snapshot: (x) => ({ ...x, batterySocPct: pct(60) }) }));
    const s = p.surplus;
    if (s === undefined || full.surplus === undefined) throw new Error('no surplus once the battery is full');
    expect(Date.parse(s.from)).toBeGreaterThan(Date.parse(full.surplus.from));
    const atFrom = p.steps.filter((x) => x.roomId === 'bedroom-1' && Date.parse(x.ts) <= Date.parse(s.from)).at(-1);
    expect(atFrom?.batteryTargetSocPct).toBeGreaterThanOrEqual(sunny().deps.config.planner.surplus.socFullPct);
  });

  /** The same home with the profile changed (an inverter limit, a unit). */
  const withProfile = (w: ReturnType<typeof world>, f: (p: HomeProfile) => HomeProfile) => {
    const home = w.deps.homes(w.ctx.homeId);
    if (home === undefined) throw new Error('no home');
    return { ...w.deps, homes: () => ({ ...home, profile: f(home.profile) }) };
  };

  it('the person at risk first: if the safe room cannot have the surplus, nobody has it (#226 review)', async () => {
    const w = sunny();
    const deps = withProfile(w, (p) => ({
      ...p,
      rooms: p.rooms.map((r) => (r.id === 'bedroom-1' ? { ...r, hvacUnits: r.hvacUnits.map((u) => ({ ...u, inputKw: { ...u.inputKw, nominal: kilowatt(9) } })) } : r)),
    }));
    const r = await planComfort(deps, { goal: 'cool' }, w.ctx);
    expect(r.ok && r.value.surplus).toBeFalsy();
  });

  it('when the guard refuses the plan with the surplus, the plan without it stands and the log says why (#226 review)', async () => {
    const w = sunny();
    const deps = withProfile(w, (p) => ({ ...p, inverterMaxAcW: watt(SURPLUS_TIGHT_INVERTER_W) }));
    const r = await planComfort(deps, { goal: 'cool' }, w.ctx);
    expect(r.ok && r.value.surplus).toBeFalsy();
    const line = w.logger.lines.find((l) => l.details?.['event'] === 'surplus_refused');
    expect(line).toMatchObject({ level: 'info', correlationId: 'test-correlation' });
    expect((line?.details?.['failed'] as string[] | undefined)?.length).toBeGreaterThan(0);
  });

  it('no surplus when nothing is exported, off grid, when heating, or on a plan the model proposed', async () => {
    expect((await planned(world('clear-day', 0))).surplus).toBeUndefined();
    expect((await planned(world('heatwave', 14, { snapshot: (x) => ({ ...x, gridAvailable: false }) }))).surplus).toBeUndefined();
    const coldSpell = (f: Forecast): Forecast => ({ ...f, hourly: f.hourly.map((h) => ({ ...h, tempOutC: celsius(12), humidityOutPct: pct(40) })) });
    expect((await planned(world('heatwave', 14, { forecast: coldSpell }), { goal: 'heat' })).surplus).toBeUndefined();
    // A plan the model proposed is checked as it is, never given the surplus. (When the guard refuses it the
    // planner's own plan comes back instead, #228, and that one may carry the surplus.) Wide humidity limits
    // here, so the proposal itself passes on this sunny day.
    const wide = PreferencesSchema.parse({ ...preferences, safety: { ...preferences.safety, humidity: { minPct: 20, maxPct: 90 } } });
    const w = world('heatwave', 14, { preferences: wide });
    const proposed = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(23) }, w.ctx);
    expect(proposed.ok && proposed.value.refusedProposal).toBeUndefined();
    expect(proposed.ok && proposed.value.surplus).toBeUndefined();
    const own = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    expect(own.ok && own.value.surplus).toBeDefined();
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
    const empty = world('heatwave', 14, { snapshot: (s) => ({ ...s, rooms: s.rooms.map((x) => ({ ...x, occupants: x.occupants.length > 0 ? ['daughter', 'son'] : [] })) }) });
    expect((await frameIn(empty, 'cool')).nightRecoveryMode).toBe('standard');
  });
});
