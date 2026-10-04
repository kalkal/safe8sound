import { celsius, pct, type Plan } from '@cold-reserve/contracts';
import { examplePlan } from '@cold-reserve/contracts/fixtures';
import { nightWindowHours } from '@cold-reserve/guard';
import { describe, expect, it } from 'vitest';
import { applySummary, outlookSummary, planSummary } from '../../src/modules/comfort-plan/summaries.js';
import { applyPlan } from '../../src/modules/comfort-plan/apply-plan.js';
import { planComfort } from '../../src/modules/comfort-plan/plan-comfort.js';
import { reserveOutlook } from '../../src/modules/comfort-plan/reserve-outlook.js';
import { localIso, localTimeText } from '@cold-reserve/core';
import { REAL, guardConfig, world } from './support.js';

// The agent (Strands) reads only the text content of a tool result, not structuredContent (F7): every
// number and fact it may say must be in the summary.

const one = (x: number) => x.toFixed(1);
const night = guardConfig().nightRecovery;
const NIGHT = { nightWindowHours: nightWindowHours(night.windowStartHour, night.windowEndHour), nightStartHour: night.windowStartHour, nightEndHour: night.windowEndHour, timeZone: 'Europe/Rome' };

describe('what the model reads', () => {
  it('plan_comfort: plan id, level, horizon, every guarantee with its reason, the reserve, the night and the counterfactual', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const p = r.value;
    const text = planSummary(p, NIGHT);
    expect(text).toContain(p.id);
    expect(text).toContain(`${p.steps[0]?.level ?? ''} level`);
    expect(text).toContain(`until ${localTimeText(p.horizonAt)}`);
    // Every time in the text as a clock time in the home's zone, never an ISO stamp (#160 acceptance test).
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT/);
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
    // The peak as the home's clock time, with the offset of the plan's own local times.
    const clock = (iso: string) => localTimeText(localIso(Date.parse(iso), w.profile.location.tz));
    expect(text).toContain(`Without the plan the safe room (${c?.roomId ?? ''}) would peak at ${String(c?.scenarios.noPlan.peakTempC)} °C at ${clock(c?.scenarios.noPlan.peakAt ?? '')}`);
    for (const line of Object.values(c?.scenarios ?? {})) {
      expect(text).toContain(`${String(line.peakTempC)} °C at ${clock(line.peakAt)}`);
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

  it('plan_comfort: a last resort says until when the room is safe and why, and that it takes two explicit yeses', async () => {
    const w = world('storm-blackout', 3, { snapshot: (x) => ({ ...x, batterySocPct: pct(35) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const text = planSummary(r.value, NIGHT);
    expect(r.value.lastResort).toBeDefined();
    expect(text).toContain(r.value.warnings?.find((x) => x.code === 'last_resort_plan')?.message ?? 'missing');
    // It can be applied, only with two explicit yeses (#168): the text must not make the model refuse.
    expect(text).toMatch(/Last resort: the safest plan there is, but not every guarantee holds\. It can be applied only with two explicit yeses: read the person the risk and until when the safe room is safe \(\d{1,2}:\d\d (AM|PM)\), ask; if they say yes, call apply_plan with planId \S+ and ask again with what it returns\./);
    expect(text).not.toContain('cannot be applied');
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT/);
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

  it('a last resort opens with its honest window, never "level until" the horizon (CE-21)', () => {
    const base = examplePlan();
    const lr = { safeUntil: '2026-07-18T01:20:00+02:00', safeHours: 9.33, limitedBy: 'temperature' as const };
    const text = planSummary({ ...base, lastResort: lr } as Plan, NIGHT);
    expect(text.startsWith(`Proposed last-resort plan ${base.id}: the safe room alone, within its limits until ${localTimeText(lr.safeUntil)} (nothing changes until apply_plan)`)).toBe(true);
    expect(text).not.toContain(`level until ${localTimeText(base.horizonAt)}`);
    const battery = planSummary({ ...base, lastResort: { ...lr, limitedBy: 'battery' as const } } as Plan, NIGHT);
    expect(battery.startsWith(`Proposed last-resort plan ${base.id}: the safe room alone, until the battery runs out at ${localTimeText(lr.safeUntil)}`)).toBe(true);
    // A plan that holds keeps its first sentence.
    expect(planSummary(base as Plan, NIGHT).startsWith(`Proposed plan ${base.id}: `)).toBe(true);
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

  it('when the battery ends the safe hours, says honestly what the room does then: warmer and more humid when cooling (#160 acceptance test)', () => {
    const lr = { safeUntil: '2026-07-17T23:40:00+02:00', safeHours: 1.67, limitedBy: 'battery' as const };
    const text = planSummary({ ...examplePlan(), lastResort: lr } as Plan, NIGHT);
    expect(text).toContain('Once the battery runs out the split stops: the safe room gets warmer and more humid.');
    expect(text).not.toContain('as the guarantees above say');
    expect(planSummary({ ...examplePlan(), lastResort: { ...lr, limitedBy: 'temperature' as const } } as Plan, NIGHT)).not.toContain('Once the battery runs out');
  });

  it('in the heating season the room gets colder once the battery runs out, never "warmer" (#177 review)', () => {
    const lr = { safeUntil: '2026-01-18T03:00:00+01:00', safeHours: 5, limitedBy: 'battery' as const };
    const heated = { ...examplePlan(), goal: 'heat', steps: examplePlan().steps.map((s) => ({ ...s, hvacMode: 'heat' })), lastResort: lr } as Plan;
    const text = planSummary(heated, NIGHT);
    expect(text).toContain('Once the battery runs out the split stops: the safe room gets colder.');
    expect(text).not.toContain('warmer');
  });

  it('peak times in the home zone at their own date, across a daylight-saving change (#177 review)', () => {
    const line = (peakAt: string) => ({ peakTempC: 30, peakAt, heatIndexDegreeHours: 1, hoursAtOrBelowThreshold: 0 });
    // The horizon is before the change (+01:00); the peak is after it (+02:00 in Rome): 10:00Z is 12:00 PM.
    const p = {
      ...examplePlan(),
      horizonAt: '2026-03-29T01:00:00+01:00',
      counterfactual: { roomId: 'bedroom-1', scenarios: { noPlan: line('2026-03-29T10:00:00.000Z'), naive: line('2026-03-29T10:00:00.000Z'), plan: line('2026-03-29T10:00:00.000Z') } },
    } as Plan;
    expect(planSummary(p, NIGHT)).toContain('would peak at 30 °C at 12:00 PM (');
  });

  it('when the worst point is at safeUntil, says "at" that time, never "up to … by" it', () => {
    const at = '2026-07-18T01:15:00+02:00';
    const lr = { safeUntil: at, safeHours: 10, limitedBy: 'battery' as const, comfortLimitC: 26, worstC: 26.4, worstAt: at };
    expect(planSummary({ ...examplePlan(), lastResort: lr } as Plan, NIGHT)).toContain(
      `The battery lasts until ${localTimeText(at)}; at ${localTimeText(at)} the safe room is at 26.4 °C, past its 26 °C night limit.`,
    );
  });

  it('plan_comfort, end to end: grandpa in the safe room at 30 % hears the honest window of the hold, first sentence first', async () => {
    const w = world('storm-blackout', 3, { snapshot: (x) => ({ ...x, batterySocPct: pct(30) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const lr = r.value.lastResort;
    if (lr?.worstC === undefined || lr.worstAt === undefined) throw new Error('no window');
    // Pre-cooled before 22:00, the room is inside the 24 °C night limit when it starts: no limit "came down" on it.
    expect(lr.loweredLimitC).toBeUndefined();
    const until = localTimeText(lr.safeUntil);
    const text = planSummary(r.value, NIGHT);
    expect(text.startsWith(`Proposed last-resort plan ${r.value.id}: the safe room alone, `)).toBe(true);
    expect(text).toContain(`${lr.limitedBy === 'battery' ? `The battery lasts until ${until}` : `Safe until ${until}`}; `);
    expect(text).toContain(`${String(lr.worstC)} °C`);
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

  it('apply_plan, a last resort applied: says how the family alert went, plainly (#170)', () => {
    const applied = { plan: { ...examplePlan(), status: 'applied' } as Plan, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] };
    expect(applySummary({ ...applied, familyAlert: { sent: 2, failed: 0 } })).toContain('2 registered family contacts were alerted.');
    expect(applySummary({ ...applied, familyAlert: { sent: 1, failed: 0 } })).toContain('1 registered family contact was alerted.');
    expect(applySummary({ ...applied, familyAlert: { sent: 1, failed: 1 } })).toContain('The family alert could not be sent to 1 of 2 contacts: call them now.');
    expect(applySummary({ ...applied, familyAlert: { sent: 0, failed: 0 } })).toContain('No family contact is registered, so nobody was alerted.');
    expect(applySummary(applied)).not.toContain('family');
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
    // The family alert is said when it happened, never promised (#170 review).
    expect(text).not.toContain('family');
    // The second yes is the person's tap on the card (#201): the model never sees the token, its format or a way to pass it.
    expect(text).toContain(`The second yes is a tap on the card, "Yes, apply it now", before ${localTimeText(r.value.confirmation.expiresAt)}.`);
    expect(text).toContain('Never ask the person for a token or a code, and never make one up.');
    expect(text).not.toContain(r.value.confirmation.token);
    expect(text).not.toMatch(/lr_|lastResortToken|token (that )?starts/i);
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

  it('a refused proposal: the first words say the guard refused it and why, then that this plan holds and is ready to apply (#202)', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(22), roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const text = planSummary(r.value, NIGHT);
    expect(r.value.refusedProposal?.message).toMatch(/Nearest allowed: 6000 W\.$/);
    expect(text.startsWith(`The guard refused the proposed setpoint and rooms: ${r.value.refusedProposal?.message ?? ''} This plan holds instead and is ready to apply. Proposed plan ${r.value.id}: `)).toBe(true);
    // Never sends the model back to propose again: the plan that holds is already here.
    expect(text).not.toMatch(/call plan_comfort again/);
  });
});
