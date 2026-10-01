import { celsius } from '@cold-reserve/contracts';
import { nightWindowHours } from '@cold-reserve/guard';
import { describe, expect, it } from 'vitest';
import { applySummary, outlookSummary, planSummary } from '../../src/modules/comfort-plan/summaries.js';
import { applyPlan } from '../../src/modules/comfort-plan/apply-plan.js';
import { planComfort } from '../../src/modules/comfort-plan/plan-comfort.js';
import { reserveOutlook } from '../../src/modules/comfort-plan/reserve-outlook.js';
import { REAL, guardConfig, world } from './support.js';

// The agent (Strands) reads only the text content of a tool result, not structuredContent (F7): every
// number and fact it may say must be in the summary.

const one = (x: number) => x.toFixed(1);
const night = guardConfig().nightRecovery;
const NIGHT = { nightWindowHours: nightWindowHours(night.windowStartHour, night.windowEndHour) };

describe('what the model reads', () => {
  it('plan_comfort: plan id, level, horizon, every guarantee with its reason, the reserve, the night and the counterfactual', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const p = r.value;
    const text = planSummary(p, NIGHT);
    expect(text).toContain(p.id);
    expect(text).toContain(`${p.steps[0]?.level ?? ''} level`);
    expect(text).toContain(p.horizonAt);
    for (const g of p.guarantees) expect(text).toContain(`${g.id} ${g.ok ? 'holds' : 'FAILS'}: ${g.reason}`);
    expect(text).toContain(`${one(p.reserveWh / 1000)} kWh`);
    expect(text).toContain(`${one(p.reserveFloorSocPct ?? -1)} %`);
    // The 36-hour heatwave shows the whole night: the hours are required and reported.
    const n = p.nightRecovery;
    expect(n?.requiredHours).toBeGreaterThan(0);
    expect(text).toContain(`Night recovery (elderly) ${n?.status ?? ''}: ${String(n?.achievedHours)} of ${String(n?.requiredHours)} hours at or below 24 °C`);
    expect(text).not.toContain('of 0 hours');
    for (const wn of p.warnings ?? []) expect(text).toContain(wn.message);
    const c = p.counterfactual;
    expect(c).toBeDefined();
    expect(text).toContain(`Without the plan the safe room (${c?.roomId ?? ''}) would peak at ${String(c?.scenarios.noPlan.peakTempC)} °C at ${c?.scenarios.noPlan.peakAt ?? ''}`);
    for (const line of Object.values(c?.scenarios ?? {})) {
      expect(text).toContain(`${String(line.peakTempC)} °C at ${line.peakAt}`);
      expect(text).toContain(`${one(line.heatIndexDegreeHours)} heat-index degree-hours, ${one(line.hoursAtOrBelowThreshold)} night hours at or below the threshold`);
    }
    expect(text).toContain('apply_plan');
  });

  it('plan_comfort: a night the plan sees only in part is not assessable yet', async () => {
    // The 24-hour clear day ends at local midnight: the plan sees 2 of the 9 night hours, so nothing is required yet.
    const w = world('clear-day', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.nightRecovery?.requiredHours).toBe(0);
    const text = planSummary(r.value, NIGHT);
    expect(text).toContain('not assessable yet: the plan covers only 2 of the 9 night hours.');
    expect(text).not.toContain('of 0 hours');
  });

  it('plan_comfort: the night line says the heat budget when it fails, and "not assessable" only on a partial night', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const n = r.value.nightRecovery;
    if (n === undefined) throw new Error('no night');
    const say = (over: Partial<typeof n>) => planSummary({ ...r.value, nightRecovery: { ...n, ...over } }, NIGHT);
    // A full night with no hour required by config is not "not assessable".
    expect(say({ requiredHours: 0, status: 'met' })).not.toContain('not assessable');
    // No hour required and over the budget: the reason is the heat, not "0.5 of 0 hours".
    const hot = say({ requiredHours: 0, achievedHours: 0.5, status: 'unmet', heatIndexDegreeHoursAbove26_7: 7.2, budgetDegreeHours: 4 });
    expect(hot).toContain('Night recovery (elderly) unmet: the heat would reach 7.2 heat-index degree-hours above 26.7 °C, over the 4 allowed.');
    expect(hot).not.toContain('of 0 hours');
    // Hours missed and over the budget: both.
    const both = say({ requiredHours: 6, achievedHours: 2, status: 'unmet', heatIndexDegreeHoursAbove26_7: 7.2, budgetDegreeHours: 4 });
    expect(both).toContain('Night recovery (elderly) unmet: 2 of 6 hours at or below 24 °C, and the heat would reach 7.2 heat-index degree-hours above 26.7 °C, over the 4 allowed.');
  });

  it('plan_comfort: a night the plan sees whole is reported with its hours, and with the grid down there is no grid-up floor', async () => {
    const w = world('storm-blackout', 3);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const p = r.value;
    const text = planSummary(p, NIGHT);
    const n = p.nightRecovery;
    expect(n?.requiredHours).toBeGreaterThan(0);
    expect(text).toContain(`Night recovery (${n?.mode ?? ''}) ${n?.status ?? ''}: ${String(n?.achievedHours)} of ${String(n?.requiredHours)} hours at or below ${String(n?.thresholdC)} °C`);
    expect(p.gridAvailable).toBe(false);
    expect(p.reserveFloorSocPct).toBeUndefined();
    expect(text).toContain(`Storm reserve ${one(p.reserveWh / 1000)} kWh.`);
    expect(text).not.toContain('while the grid is up');
  });

  it('plan_comfort: what the plan does in each room, and every step down the person pre-authorizes (plan §9.4)', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const p = r.value;
    const text = planSummary(p, NIGHT);
    for (const roomId of new Set(p.steps.map((s) => s.roomId))) {
      const s = [...p.steps].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).find((x) => x.roomId === roomId);
      if (s === undefined) throw new Error('no step');
      expect(text).toContain(`${roomId}: ${s.hvacMode === 'off' ? 'off' : `${s.hvacMode} at ${String(s.setpointC)} °C`}`);
    }
    for (const rung of p.ladder) {
      const offset = `${rung.setpointOffsetK >= 0 ? '+' : ''}${String(rung.setpointOffsetK)} K`;
      expect(text).toContain(`${rung.level}: setpoint ${offset}, ${rung.preferredModes.join(' or ')}, fans ${rung.fansOn ? 'on' : 'off'}`);
      expect(text).toContain(rung.roomIds.length > 0 ? rung.roomIds.join(', ') : 'no rooms');
    }
  });

  it('plan_comfort: says whether the plan rests on simulated or live data', async () => {
    const sim = world('heatwave', 14);
    const a = await planComfort(sim.deps, { goal: 'cool' }, sim.ctx);
    if (!a.ok) throw new Error(a.error.message);
    expect(planSummary(a.value, NIGHT)).toContain('simulated data');
    const live = { energy: 'live', rooms: 'live', weather: 'live' } as const;
    const real = world('heatwave', 14, { homeId: REAL, readOnly: true, snapshot: (s) => ({ ...s, origin: live }) });
    const b = await planComfort(real.deps, { goal: 'cool' }, real.ctx);
    if (!b.ok) throw new Error(b.error.message);
    expect(planSummary(b.value, NIGHT)).toContain('live data');
    expect(planSummary(b.value, NIGHT)).not.toContain('simulated');
  });

  it('apply_plan: what happened, and on the real home every manual step', async () => {
    const live = { energy: 'live', rooms: 'live', weather: 'live' } as const;
    const w = world('heatwave', 14, { homeId: REAL, readOnly: true, snapshot: (s) => ({ ...s, origin: live }) });
    const planned = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!planned.ok) throw new Error(planned.error.message);
    const r = await applyPlan(w.deps, { planId: planned.value.id }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const text = applySummary(r.value);
    expect(text).toContain(`Plan ${planned.value.id} applied as advice`);
    for (const m of r.value.manualInstructions) expect(text).toContain(m.text);
    expect(applySummary({ ...r.value, alreadyApplied: true })).toContain('was already applied');
  });

  it('get_reserve_outlook: the level and the three hour counts', async () => {
    const w = world('heatwave', 14);
    const r = await reserveOutlook(w.deps, {}, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const o = r.value;
    const text = outlookSummary(o);
    expect(text).toContain(`${one(o.hoursAtCurrentLevel)} hours at ${o.level}`);
    expect(text).toContain(`${one(o.hoursAtEssential)} hours at essential`);
    expect(text).toContain(`${one(o.reserveHoursAtEssential)} hours`);
    expect(text).toContain('simulated');
  });

  it('a refusal names the value the guard would accept', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(22), roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] }, w.ctx);
    expect(!r.ok && r.error.message).toMatch(/Nearest allowed: 6000 W\.$/);
  });
});
