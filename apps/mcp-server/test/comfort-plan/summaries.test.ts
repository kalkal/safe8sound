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
  it('plan_comfort ends with the plan waiting for the yes, so a plain "yes" next turn applies it (#274)', () => {
    const p = examplePlan() as Plan;
    expect(planSummary(p, { ...NIGHT, roomNames: {} })).toMatch(new RegExp(`Plan ${p.id} is waiting for the person's yes: when they say yes, call apply_plan with planId ${p.id}\\.$`));
  });

  it('plan_comfort names the safe room in the counterfactual, its id only in parentheses (#274)', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    if (r.value.counterfactual === undefined) throw new Error('no counterfactual');
    const text = planSummary(r.value, { ...NIGHT, roomNames: { 'bedroom-1': 'Bedroom' } });
    expect(text).toContain('Without the plan the safe room, Bedroom (bedroom-1), would peak at');
  });

  describe('in the unit the sandbox chose (#306)', () => {
    const F = { ...NIGHT, unit: 'F' as const };

    it('the surplus rooms in °F: the gap comes from the rounded absolutes, so now − comfort adds up', () => {
      const surplus = {
        from: '2026-07-16T16:00:00+02:00',
        to: '2026-07-16T20:05:00+02:00',
        keptKWh: 3.4,
        comfortC: 24,
        rooms: [
          { roomId: 'bedroom-1', setpointC: 24, reason: 'safe_room' as const, aboveTargetK: 1 },
          { roomId: 'bedroom-2', setpointC: 23, reason: 'occupied_tonight' as const, aboveTargetK: 6.9 },
          { roomId: 'study', setpointC: 23, reason: 'occupied' as const, aboveTargetK: -0.4 },
        ],
      };
      const names = { 'bedroom-1': 'Bedroom', 'bedroom-2': 'Second bedroom', study: 'Study' };
      const text = planSummary({ ...examplePlan(), surplus } as Plan, { ...F, roomNames: names });
      // 30.9 °C is 87.62 °F, said 87.6; the comfort 75.2; the gap 87.6 − 75.2 = 12.4, never 6.9 × 1.8 = 12.42 rounded alone.
      expect(text).toContain(
        '1) Bedroom (safe room), now 77.0 °F, 1.8 °F above the 75.2 °F comfort, cooling to 75.2 °F; ' +
          '2) Second bedroom (slept in tonight), now 87.6 °F, 12.4 °F above the 75.2 °F comfort, cooling to 73.4 °F; ' +
          '3) Study (occupied), now 74.5 °F, 0.7 °F below the 75.2 °F comfort, cooling to 73.4 °F.',
      );
      // Without the comfort there is no absolute to round: the gap alone, × 1.8.
      const older = { from: surplus.from, to: surplus.to, keptKWh: surplus.keptKWh, rooms: surplus.rooms };
      expect(planSummary({ ...examplePlan(), surplus: older } as Plan, { ...F, roomNames: names })).toContain('1) Bedroom (safe room), 1.8 °F above comfort, cooling to 75.2 °F;');
    });

    it('the guided storm in °F: the window, the night warning line and the counterfactual, with no °C left in them', async () => {
      const w = world('storm-blackout', 10, { snapshot: (x) => ({ ...x, batterySocPct: pct(17) }) });
      const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
      if (!r.ok) throw new Error(r.error.message);
      const text = planSummary(r.value, F);
      // 24 °C is 75.2 °F; 24.5 °C is 76.1 °F.
      expect(text).toContain('The safe room stays at or below its 75.2 °F night limit until about 3:35 AM (the battery lasts until 12:50 AM), then warms up to 76.1 °F by 6:10 AM.');
      const counterfactual = text.split(/(?<=\.) /).find((x) => x.startsWith('Without the plan')) ?? '';
      expect(counterfactual).toMatch(/would peak at \d+(\.\d)? °F at /);
      expect(counterfactual).toContain('heat-index °F-hours');
      expect(counterfactual).not.toContain('°C');
      expect(text).toMatch(/What it does: .*cool at \d+(\.\d)? °F/);
    });

    it('the night line in °F: hours at or below the threshold in °F, the heat budget as °F-hours, the same amount as in °C', () => {
      const night = { roomId: 'bedroom-1', mode: 'elderly', thresholdC: 24, window: { start: '2026-07-17T20:00:00.000Z', end: '2026-07-18T05:00:00.000Z' }, requiredHours: 6, achievedHours: 3.67, status: 'unmet', heatIndexDegreeHoursAbove26_7: 5, budgetDegreeHours: 4 };
      const p = { ...examplePlan(), nightRecovery: night } as Plan;
      expect(planSummary(p, NIGHT)).toContain('3.67 of 6 hours at or below 24 °C, and the heat would reach 5 heat-index degree-hours above 26.7 °C, over the 4 allowed.');
      // 5 and 4 degree-hours (°C) are 9 and 7.2 °F-hours: the same amount; the threshold 26.7 °C is 80.1 °F.
      expect(planSummary(p, F)).toContain('3.67 of 6 hours at or below 75.2 °F, and the heat would reach 9 heat-index °F-hours above 80.1 °F, over the 7.2 allowed.');
      // Just over the budget: the amount rounded up, never "7.2 over the 7.2" (#306 review).
      const close = { ...p, nightRecovery: { ...night, heatIndexDegreeHoursAbove26_7: 4.01 } } as Plan;
      expect(planSummary(close, F)).toContain('the heat would reach 7.3 heat-index °F-hours above 80.1 °F, over the 7.2 allowed.');
    });
  });

  it('plan_comfort: where the solar surplus went, in order, by room name, with every number (#203)', () => {
    const surplus = {
      from: '2026-07-16T16:00:00+02:00',
      to: '2026-07-16T20:05:00+02:00',
      keptKWh: 3.4,
      comfortC: 24,
      rooms: [
        { roomId: 'bedroom-1', setpointC: 24, reason: 'safe_room' as const, aboveTargetK: 1 },
        { roomId: 'bedroom-2', setpointC: 23, reason: 'occupied_tonight' as const, aboveTargetK: 6.9 },
        { roomId: 'study', setpointC: 23, reason: 'occupied' as const, aboveTargetK: -0.4 },
      ],
    };
    const names = { 'bedroom-1': 'Bedroom', 'bedroom-2': 'Second bedroom', study: 'Study' };
    const text = planSummary({ ...examplePlan(), surplus } as Plan, { ...NIGHT, roomNames: names });
    // Owner feedback: "cooled to 23 °C · 6.9 °C above target" was not understood; the room now, the comfort, then the setpoint.
    expect(text).toContain(
      'Solar surplus from 4:00 PM to 8:05 PM: 3.4 kWh kept at home instead of exported to the grid. Where it went, in order: ' +
        '1) Bedroom (safe room), now 25.0 °C, 1.0 °C above the 24.0 °C comfort, cooling to 24 °C; ' +
        '2) Second bedroom (slept in tonight), now 30.9 °C, 6.9 °C above the 24.0 °C comfort, cooling to 23 °C; ' +
        '3) Study (occupied), now 23.6 °C, 0.4 °C below the 24.0 °C comfort, cooling to 23 °C.',
    );
    expect(text).not.toContain('target');
    // A plan without the comfort (older): no "now" figure it cannot know, and still no "target".
    const older = { from: surplus.from, to: surplus.to, keptKWh: surplus.keptKWh, rooms: surplus.rooms };
    const olderText = planSummary({ ...examplePlan(), surplus: older } as Plan, { ...NIGHT, roomNames: names });
    expect(olderText).toContain('1) Bedroom (safe room), 1.0 °C above comfort, cooling to 24 °C;');
    expect(olderText).not.toContain('target');
    for (const id of ['bedroom-2', 'study']) expect(text.slice(text.indexOf('Solar surplus'))).not.toContain(id);
    expect(planSummary(examplePlan() as Plan, { ...NIGHT, roomNames: names })).not.toContain('Solar surplus');
  });

  it('plan_comfort: the household tip from the surplus, its cycle, its window and every time in it (#219)', () => {
    const tip = { load: 'washing' as const, cycle: 'eco' as const, windowFrom: '2026-07-16T12:00:00+02:00', windowTo: '2026-07-16T17:30:00+02:00', probable: false };
    const text = planSummary({ ...examplePlan(), householdTip: tip } as Plan, { ...NIGHT, roomNames: {} });
    expect(text).toContain('Good time to run the washing machine from 12:00 PM: an eco cycle fits; the sun should cover it until about 5:30 PM. Advice only, nothing is switched on.');
    const normal = planSummary({ ...examplePlan(), householdTip: { ...tip, cycle: 'normal' } } as Plan, { ...NIGHT, roomNames: {} });
    expect(normal).toContain('a normal cycle fits');
    const cooking = planSummary({ ...examplePlan(), householdTip: { ...tip, load: 'cooking', cycle: undefined } } as Plan, { ...NIGHT, roomNames: {} });
    expect(cooking).toContain('Good time to cook from 12:00 PM: the sun should cover it until about 5:30 PM.');
    // Low forecast confidence: "probably", and no end time.
    const probable = planSummary({ ...examplePlan(), householdTip: { ...tip, probable: true } } as Plan, { ...NIGHT, roomNames: {} });
    expect(probable).toContain('Probably a good time to run the washing machine from 12:00 PM: an eco cycle should fit.');
    expect(probable).not.toContain('5:30 PM');
    expect(planSummary(examplePlan() as Plan, { ...NIGHT, roomNames: {} })).not.toContain('Good time');
  });

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
    const w = world('storm-blackout', 3, { snapshot: (x) => ({ ...x, batterySocPct: pct(20) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const text = planSummary(r.value, NIGHT);
    expect(r.value.lastResort).toBeDefined();
    expect(text).toContain(r.value.warnings?.find((x) => x.code === 'last_resort_plan')?.message ?? 'missing');
    // It can be applied, only with two explicit yeses (#168): the text must not make the model refuse.
    expect(text).toMatch(/Last resort: the safest plan there is, but not every guarantee holds\. It can be applied only with two explicit yeses: read the person the risk and until when the safe room stays within its limits \(\d{1,2}:\d\d (AM|PM)\), ask; if they say yes, call apply_plan with planId \S+ and ask again with what it returns\./);
    expect(text).not.toContain('cannot be applied');
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT/);
  });

  it('plan_comfort: when the battery ends it, says until when the battery lasts and how far the room then goes, every number (#160)', async () => {
    const w = world('storm-blackout', 3, { snapshot: (x) => ({ ...x, batterySocPct: pct(20), rooms: x.rooms.map((r) => ({ ...r, occupants: r.occupants.length > 0 ? ['daughter', 'son'] : [] })) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const lr = r.value.lastResort;
    if (lr?.worstAt === undefined || lr.worstC === undefined || lr.comfortLimitC === undefined) throw new Error('no window');
    expect(lr.limitedBy).toBe('battery');
    if (lr.limitCrossedAt === undefined || lr.limitCrossedC === undefined) throw new Error('no crossing');
    // One sentence, both times and no duration (#272): the battery runs out, the room holds the limit it then
    // crosses a while longer, then warms up.
    const text = planSummary(r.value, NIGHT);
    expect(text).toContain(`The safe room stays at or below its ${String(lr.limitCrossedC)} °C`);
    expect(text).toContain(`limit until about ${localTimeText(lr.limitCrossedAt)} (the battery lasts until ${localTimeText(lr.safeUntil)}), then warms up to ${String(lr.worstC)} °C by ${localTimeText(lr.worstAt)}.`);
    expect(text).not.toContain('hours from now');
  });

  it('the 22:00 storm at 17 % of the guided test: the battery at 12:50 AM, the room under 24 °C until about 3:35 AM, in one sentence (#272)', async () => {
    // The night-recovery count (5 h at or below 24 °C) starts at 22:00 with the room just above 24 °C in the grace
    // period; the room then holds 24 °C by inertia after the battery runs out, until it crosses it at 3:35 AM.
    const w = world('storm-blackout', 10, { snapshot: (x) => ({ ...x, batterySocPct: pct(17) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    expect(planSummary(r.value, NIGHT)).toContain('The safe room stays at or below its 24 °C night limit until about 3:35 AM (the battery lasts until 12:50 AM), then warms up to 24.5 °C by 6:10 AM.');
  });

  it('the guided storm: the whole summary has one end time and at most one hours figure for 24 °C (#272 review)', async () => {
    const w = world('storm-blackout', 10, { snapshot: (x) => ({ ...x, batterySocPct: pct(17) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const text = planSummary(r.value, NIGHT);
    const about24 = text.split(/(?<=\.) /).filter((s) => s.includes('24 °C'));
    expect(about24.length).toBeGreaterThan(0);
    expect(about24.flatMap((s) => s.match(/\d+(\.\d+)? hours/g) ?? []).length).toBeLessThanOrEqual(1);
    // Every sentence that carries a duration (#299): only the battery's, both ending at 12:50 AM like the window says;
    // none for the room's threshold, the counterfactual's night hours included.
    const durations = text.split(/(?<=\.) /).filter((s) => /\d+(\.\d+)? (night )?(hours?|minutes?|min|h)\b/.test(s));
    expect(durations).toEqual([
      expect.stringMatching(/^pacing_on_track FAILS: At this pace the battery runs out at 00:50, \d+ min before the next recharge at 08:00\.$/),
    ]);
    // #364: the warning says the room's time first and the battery's after it, with no duration.
    expect(text).toContain('Warning: No plan keeps the Bedroom within its limits until the next recharge: within them until about 3:35 AM, the battery until 12:50 AM; then it warms up.');
    expect(text).not.toContain('night hours');
    // The night count (5 h, grace minutes included) stays in nightRecovery for the card, not in the text.
    expect(text).not.toContain('Night recovery (');
    expect(text).not.toContain('hours from now');
    expect(r.value.nightRecovery?.achievedHours).toBeGreaterThan(0);
  });

  it('names the limit the room crosses, not the one at the worst point (#272 review)', () => {
    const lr = { safeUntil: '2026-07-17T20:10:00+02:00', safeHours: 1.5, limitedBy: 'battery' as const, comfortLimitC: 24, worstC: 27.4, worstAt: '2026-07-18T03:00:00+02:00', limitCrossedAt: '2026-07-17T20:40:00+02:00', limitCrossedC: 27 };
    const text = planSummary({ ...examplePlan(), lastResort: lr } as Plan, NIGHT);
    expect(text).toContain('The safe room stays at or below its 27 °C limit until about 8:40 PM (the battery lasts until 8:10 PM), then warms up to 27.4 °C by 3:00 AM.');
  });

  it('the night warning and the last-resort window end at the same clock time, with no second duration (#272)', async () => {
    const w = world('storm-blackout', 10, { snapshot: (x) => ({ ...x, batterySocPct: pct(17) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const crossed = r.value.lastResort?.limitCrossedAt;
    if (crossed === undefined) throw new Error('no crossing');
    const night = r.value.warnings?.find((x) => x.code === 'night_recovery_infeasible')?.message ?? '';
    expect(night).toBe(`Tonight the Bedroom stays at or below 24 °C until about ${localTimeText(crossed)}, then it warms up.`);
    expect(night).not.toMatch(/hours/);
    // The hours of the night under the limit stay in the structured data, for the card.
    expect(r.value.nightRecovery?.achievedHours).toBeGreaterThan(0);
    expect(planSummary(r.value, NIGHT)).toContain(`until about ${localTimeText(crossed)} (the battery lasts until`);
  });

  it('when the battery runs out but the room stays inside its limits to the next recharge, says that instead (#272)', () => {
    const p = { ...examplePlan(), lastResort: { safeUntil: '2026-07-18T04:00:00+02:00', safeHours: 6, limitedBy: 'battery' } } as Plan;
    expect(planSummary(p, NIGHT)).toContain(`The safe room stays inside its temperature limit until ${localTimeText(p.horizonAt)}, the next recharge (the battery lasts until 4:00 AM).`);
  });

  it('a last resort opens with its honest window, never "level until" the horizon (CE-21)', () => {
    const base = examplePlan();
    const lr = { safeUntil: '2026-07-18T01:20:00+02:00', safeHours: 9.33, limitedBy: 'temperature' as const };
    const text = planSummary({ ...base, lastResort: lr } as Plan, NIGHT);
    expect(text.startsWith(`Proposed last-resort plan ${base.id}: the safe room alone, within its limits until ${localTimeText(lr.safeUntil)} (nothing changes until apply_plan)`)).toBe(true);
    expect(text).not.toContain(`level until ${localTimeText(base.horizonAt)}`);
    const battery = planSummary({ ...base, lastResort: { ...lr, limitedBy: 'battery' as const } } as Plan, NIGHT);
    // #364: no window with the battery: the room stays inside its limits to the next recharge, said first.
    expect(battery.startsWith(`Proposed last-resort plan ${base.id}: the safe room alone, within its limits until ${localTimeText(base.horizonAt)}, the next recharge, the battery until ${localTimeText(lr.safeUntil)} (`)).toBe(true);
    const crossing = { ...lr, limitedBy: 'battery' as const, comfortLimitC: 24, worstC: 26.1, worstAt: '2026-07-18T06:00:00+02:00', limitCrossedAt: '2026-07-18T03:35:00+02:00', limitCrossedC: 24 };
    const crossed = planSummary({ ...base, lastResort: crossing } as Plan, NIGHT);
    expect(crossed.startsWith(`Proposed last-resort plan ${base.id}: the safe room alone, within its limits until about 3:35 AM, the battery until 1:20 AM (`)).toBe(true);
    expect(crossed).toContain('until when the safe room stays within its limits (3:35 AM)');
    const window = { ...lr, limitedBy: 'battery' as const, comfortLimitC: 24, worstC: 26.1, worstAt: '2026-07-18T06:00:00+02:00' };
    expect(planSummary({ ...base, lastResort: window } as Plan, NIGHT).startsWith(`Proposed last-resort plan ${base.id}: the safe room alone, until the battery runs out at 1:20 AM`)).toBe(true);
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

  it('plan_comfort, end to end: grandpa in the safe room at 20 % hears the honest window of the hold, first sentence first', async () => {
    const w = world('storm-blackout', 3, { snapshot: (x) => ({ ...x, batterySocPct: pct(20) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const lr = r.value.lastResort;
    if (lr?.worstC === undefined || lr.worstAt === undefined) throw new Error('no window');
    // Pre-cooled before 22:00, the room is inside the 24 °C night limit when it starts: no limit "came down" on it.
    expect(lr.loweredLimitC).toBeUndefined();
    const until = localTimeText(lr.safeUntil);
    const text = planSummary(r.value, NIGHT);
    expect(text.startsWith(`Proposed last-resort plan ${r.value.id}: the safe room alone, `)).toBe(true);
    if (lr.limitCrossedAt !== undefined) expect(text).toContain(`(the battery lasts until ${until}), then warms up`);
    else expect(text).toContain(`${lr.limitedBy === 'battery' ? `The battery lasts until ${until}` : `Safe until ${until}`}; `);
    expect(text).toContain(`${String(lr.worstC)} °C`);
  });

  it('plan_comfort: what the plan does in each room, and every step down the person pre-authorizes (plan §9.4)', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const p = r.value;
    // Room labels, never internal ids (CE-13, #226 review).
    const names = Object.fromEntries(w.profile.rooms.map((x) => [x.id, x.name]));
    const text = planSummary(p, { ...NIGHT, roomNames: names });
    const doesLine = text.slice(text.indexOf('What it does:'), text.indexOf('.', text.indexOf('What it does:')));
    for (const roomId of new Set(p.steps.map((s) => s.roomId))) {
      const s = [...p.steps].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).find((x) => x.roomId === roomId);
      if (s === undefined) throw new Error('no step');
      expect(doesLine).toContain(`${names[roomId] ?? ''}: ${s.hvacMode === 'off' ? 'off' : `${s.hvacMode} at ${String(s.setpointC)} °C`}`);
      expect(doesLine).not.toContain(roomId);
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
    const w = world('storm-blackout', 3, { snapshot: (x) => ({ ...x, batterySocPct: pct(20) }) });
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

  it('get_reserve_outlook with the battery at its floor: says it is empty, never hours the reserve does not hold (#273)', async () => {
    const w = world('storm-blackout', 19, { snapshot: (s) => ({ ...s, batterySocPct: pct(10) }) });
    const r = await reserveOutlook(w.deps, {}, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toMatchObject({ hoursAtCurrentLevel: 0, hoursAtEssential: 0, reserveHoursAtEssential: 0 });
    expect(outlookSummary(r.value)).toMatch(/^The battery is empty: 0 hours on the battery, at any level, and none left in the storm reserve\. The grid is (on|down)\. As of /);
  });

  it('get_reserve_outlook says whether the grid is on', async () => {
    const up = await reserveOutlook(world('heatwave', 14).deps, {}, world('heatwave', 14).ctx);
    if (!up.ok) throw new Error(up.error.message);
    expect(outlookSummary(up.value)).toContain('The grid is on.');
    const storm = world('storm-blackout', 3);
    const down = await reserveOutlook(storm.deps, {}, storm.ctx);
    if (!down.ok) throw new Error(down.error.message);
    expect(outlookSummary(down.value)).toContain('The grid is down.');
  });

  it('get_reserve_outlook on grid counts the comfort hours above the storm reserve; off grid the whole battery (#287 review)', async () => {
    const low = world('heatwave', 14, { snapshot: (s) => ({ ...s, batterySocPct: pct(15) }) });
    const up = await reserveOutlook(low.deps, {}, low.ctx);
    if (!up.ok) throw new Error(up.error.message);
    expect(up.value.gridAvailable).toBe(true);
    expect(outlookSummary(up.value)).toMatch(/^For comfort, above the storm reserve: about /);
    const storm = world('storm-blackout', 3);
    const down = await reserveOutlook(storm.deps, {}, storm.ctx);
    if (!down.ok) throw new Error(down.error.message);
    expect(outlookSummary(down.value)).toMatch(/^On the battery alone: about /);
  });

  it('a refused proposal: the first words say the guard refused it and why, then that this plan holds and is ready to apply (#202)', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, { goal: 'cool', setpointC: celsius(22), roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const text = planSummary(r.value, NIGHT);
    expect(r.value.refusedProposal?.message).toMatch(/Nearest allowed: 6000 W\.$/);
    expect(text.startsWith(`The safety check refused the plan you proposed: ${r.value.refusedProposal?.message ?? ''} This plan holds instead and is ready to apply. Proposed plan ${r.value.id}: `)).toBe(true);
    // Never sends the model back to propose again: the plan that holds is already here.
    expect(text).not.toMatch(/call plan_comfort again/);
  });
});

describe('#376: the last-resort advice, with the number to call at the home place', () => {
  const lr = { safeUntil: '2026-07-18T01:20:00+02:00', safeHours: 9.33, limitedBy: 'temperature' as const, actions: ['close_curtains', 'drink_water', 'fan_below_35c'] as const };

  it.each([
    ['houston', '911'],
    ['turin', '112'],
    ['reference', '112'],
  ] as const)('%s: the card words, the signs and "call %s", never medical protection', (place, number) => {
    const text = planSummary({ ...examplePlan(), lastResort: { ...lr, actions: [...lr.actions], place } } as Plan, NIGHT);
    expect(text).toContain(`If you are worried, call ${number}.`);
    expect(text).toContain('Keep cool without power: Close the curtains on the sunny side. Drink water often, even without thirst. Use a fan only while the room is below 35 °C.');
    expect(text).toContain('Signs of heat stroke: Confusion or lack of coordination; Hot skin that is not sweating;');
    expect(text).toContain('These are general tips, not medical advice.');
    expect(text).not.toMatch(/\b(protects?|prevents?|treats?|cures?)\b/i);
  });

  it('in °F the fan rule is 95 °F; with no place no number at all', () => {
    expect(planSummary({ ...examplePlan(), lastResort: { ...lr, actions: [...lr.actions], place: 'houston' } } as Plan, { ...NIGHT, unit: 'F' })).toContain('below 95 °F.');
    const none = planSummary({ ...examplePlan(), lastResort: { ...lr, actions: [...lr.actions] } } as Plan, NIGHT);
    expect(none).not.toMatch(/call (911|112)/);
  });
});

describe('#364 review: heating never leads with a crossing under the minimum', () => {
  it('the first words keep the battery time; no "within its limits until about"', () => {
    const lr = { safeUntil: '2026-01-16T03:05:00+01:00', safeHours: 7.2, limitedBy: 'battery' as const, comfortLimitC: 18, worstC: 16.5, worstAt: '2026-01-16T07:00:00+01:00', limitCrossedAt: '2026-01-16T06:00:00+01:00', limitCrossedC: 18 };
    const text = planSummary({ ...examplePlan(), lastResort: lr } as Plan, NIGHT);
    expect(text).toContain('the safe room alone, until the battery runs out at 3:05 AM');
    expect(text).not.toContain('until about 6:00 AM');
    expect(text).toContain('until when the safe room stays within its limits (3:05 AM)');
  });
});
