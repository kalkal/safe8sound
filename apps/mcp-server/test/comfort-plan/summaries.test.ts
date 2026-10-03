import { celsius, pct, type Plan } from '@cold-reserve/contracts';
import { examplePlan } from '@cold-reserve/contracts/fixtures';
import { nightWindowHours } from '@cold-reserve/guard';
import { describe, expect, it } from 'vitest';
import { applySummary, outlookSummary, planSummary } from '../../src/modules/comfort-plan/summaries.js';
import { applyPlan } from '../../src/modules/comfort-plan/apply-plan.js';
import { planComfort } from '../../src/modules/comfort-plan/plan-comfort.js';
import { reserveOutlook } from '../../src/modules/comfort-plan/reserve-outlook.js';
import { localTimeText } from '../../src/time.js';
import { REAL, guardConfig, world } from './support.js';

// The agent (Strands) reads only the text content of a tool result, not structuredContent (F7): every
// number and fact it may say must be in the summary.

const one = (x: number) => x.toFixed(1);
const night = guardConfig().nightRecovery;
const NIGHT = { nightWindowHours: nightWindowHours(night.windowStartHour, night.windowEndHour), nightStartHour: night.windowStartHour, nightEndHour: night.windowEndHour };

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

  it('plan_comfort: a last resort says until when the room is safe and why, and does not invite to apply it', async () => {
    const w = world('storm-blackout', 3, { snapshot: (x) => ({ ...x, batterySocPct: pct(35) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const text = planSummary(r.value, NIGHT);
    expect(r.value.lastResort).toBeDefined();
    expect(text).toContain(r.value.warnings?.find((x) => x.code === 'last_resort_plan')?.message ?? 'missing');
    expect(text).toMatch(/Last resort: the safest plan there is, but not every guarantee holds, so it cannot be applied\. Tell the person the safe room is safe until \d{1,2}:\d\d (AM|PM) \(2026-07-1[78]T[\d:]+\+02:00\)\./);
    expect(text).not.toContain('call apply_plan');
  });

  it('plan_comfort: when the battery ends it, says until when the battery lasts and how far the room then goes, every number (#160)', async () => {
    const w = world('storm-blackout', 3, { snapshot: (x) => ({ ...x, batterySocPct: pct(30), rooms: x.rooms.map((r) => ({ ...r, occupants: r.occupants.length > 0 ? ['daughter', 'son'] : [] })) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const lr = r.value.lastResort;
    if (lr?.worstAt === undefined || lr.worstC === undefined || lr.comfortLimitC === undefined) throw new Error('no window');
    expect(lr.limitedBy).toBe('battery');
    expect(planSummary(r.value, NIGHT)).toContain(
      `The battery lasts until ${localTimeText(lr.safeUntil)}; the safe room then goes up to ${String(lr.worstC)} °C by ${localTimeText(lr.worstAt)}, past its ${String(lr.comfortLimitC)} °C night limit.`,
    );
  });

  it('when the temperature ends it: safe until, then how far past which limit; heating says down to; no window, nothing more', () => {
    const lastResort = { safeUntil: '2026-01-18T03:00:00+01:00', safeHours: 5, limitedBy: 'temperature' as const };
    const plan = (lr: object) => ({ ...examplePlan(), lastResort: lr }) as Plan;
    const cooling = { ...lastResort, safeUntil: '2026-07-18T02:40:00+02:00', comfortLimitC: 26, worstC: 29, worstAt: '2026-07-18T06:00:00+02:00' };
    expect(planSummary(plan(cooling), NIGHT)).toContain(
      `Safe until ${localTimeText(cooling.safeUntil)}; the safe room then goes up to 29 °C by ${localTimeText(cooling.worstAt)}, past its 26 °C night limit.`,
    );
    const byDay = { ...cooling, comfortLimitC: 27, worstAt: '2026-07-18T09:00:00+02:00' };
    expect(planSummary(plan(byDay), NIGHT)).toContain(`past its 27 °C limit.`);
    expect(planSummary(plan({ ...lastResort, comfortLimitC: 18, worstC: 16.9, worstAt: '2026-01-18T07:00:00+01:00' }), NIGHT)).toContain(
      `Safe until ${localTimeText(lastResort.safeUntil)}; the safe room then goes down to 16.9 °C by ${localTimeText('2026-01-18T07:00:00+01:00')}, past its 18 °C limit.`,
    );
    expect(planSummary(plan(lastResort), NIGHT)).not.toContain('the safe room then goes');
  });

  it('when the limit comes down as the safe hours end, says so with the limit then in force, never that the room crossed it (the elderly case)', () => {
    const at = '2026-07-17T22:00:00+02:00';
    const lr = { safeUntil: at, safeHours: 7, limitedBy: 'temperature' as const, comfortLimitC: 24, worstC: 25, worstAt: at, loweredLimitC: 24 };
    const text = planSummary({ ...examplePlan(), lastResort: lr } as Plan, NIGHT);
    expect(text).toContain(`From ${localTimeText(at)} the limit is 24 °C and the safe room is above it: at ${localTimeText(at)} it is at 25 °C.`);
    expect(text).not.toContain('up to 25 °C by');
    // The worst point later, in the day, past a 27 °C limit: the sentence still names the 24 °C limit of safeUntil.
    const later = { ...lr, comfortLimitC: 27, worstC: 27.4, worstAt: '2026-07-18T09:00:00+02:00' };
    expect(planSummary({ ...examplePlan(), lastResort: later } as Plan, NIGHT)).toContain(
      `From ${localTimeText(at)} the limit is 24 °C and the safe room is above it, up to 27.4 °C by ${localTimeText(later.worstAt)}.`,
    );
  });

  it('a 10 PM end that is a crossing, not a lowered limit, is never told as a lowered limit', () => {
    const at = '2026-07-17T22:00:00+02:00';
    const lr = { safeUntil: at, safeHours: 7, limitedBy: 'temperature' as const, comfortLimitC: 26, worstC: 26.5, worstAt: '2026-07-18T01:00:00+02:00' };
    const text = planSummary({ ...examplePlan(), lastResort: lr } as Plan, NIGHT);
    expect(text).not.toContain('the limit is');
    expect(text).toContain(`Safe until ${localTimeText(at)}; the safe room then goes up to 26.5 °C by ${localTimeText(lr.worstAt)}, past its 26 °C night limit.`);
  });

  it('when the worst point is at safeUntil, says "at" that time, never "up to … by" it', () => {
    const at = '2026-07-18T01:15:00+02:00';
    const lr = { safeUntil: at, safeHours: 10, limitedBy: 'battery' as const, comfortLimitC: 26, worstC: 26.4, worstAt: at };
    expect(planSummary({ ...examplePlan(), lastResort: lr } as Plan, NIGHT)).toContain(
      `The battery lasts until ${localTimeText(at)}; at ${localTimeText(at)} the safe room is at 26.4 °C, past its 26 °C night limit.`,
    );
  });

  it('plan_comfort, end to end: grandpa in the safe room at 30 % hears that the 24 °C limit comes at 10 PM with the room above it', async () => {
    const w = world('storm-blackout', 3, { snapshot: (x) => ({ ...x, batterySocPct: pct(30) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const lr = r.value.lastResort;
    if (lr?.worstC === undefined || lr.worstAt === undefined) throw new Error('no window');
    expect(lr.loweredLimitC).toBe(24);
    const how = lr.worstAt === lr.safeUntil ? `: at ${localTimeText(lr.worstAt)} it is at ${String(lr.worstC)} °C.` : `, up to ${String(lr.worstC)} °C by ${localTimeText(lr.worstAt)}.`;
    expect(planSummary(r.value, NIGHT)).toContain(`From ${localTimeText(lr.safeUntil)} the limit is 24 °C and the safe room is above it${how}`);
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

  it('apply_plan, first yes to a last resort: nothing applied, the risk to read, the family alert, and the second call only after a second yes (#160)', async () => {
    const w = world('storm-blackout', 3, { snapshot: (x) => ({ ...x, batterySocPct: pct(30) }) });
    const p = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!p.ok) throw new Error(p.error.message);
    const r = await applyPlan(w.deps, { planId: p.value.id }, w.ctx);
    if (!r.ok || r.value.confirmation === undefined) throw new Error('no confirmation');
    const text = applySummary(r.value);
    const warning = p.value.warnings?.find((x) => x.code === 'last_resort_plan')?.message ?? 'missing';
    expect(text).toMatch(/^Not applied yet: this is a last resort\. /);
    expect(text).toContain(warning);
    // The family alert is promised only where it is sent (#160 part d).
    expect(text).not.toContain('family');
    expect(text).toContain(
      `Only if the person says yes again, call apply_plan with planId ${p.value.id} and lastResortToken ${r.value.confirmation.token} (valid until ${localTimeText(r.value.confirmation.expiresAt)}).`,
    );
    expect(text).not.toContain('applied as advice');
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
