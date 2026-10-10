import { examplePlan } from '@cold-reserve/contracts/fixtures';
import { celsius, pct, type Plan } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { builtInScenario } from '@cold-reserve/source-simulator';
import { milestonesOf, outagesOf } from '../src/milestones.js';

// #311: the next interesting moments of a sandbox's day, from the scenario and the plan's own fields (one source):
// never recomputed apart from what the plan and the scenario already say.

const TZ = 'Europe/Rome';
const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-07-17T20:00:00+02:00');
const base = { nowMs: NOW, horizonMs: NOW + 24 * 3_600_000, timeZone: TZ };

const plan = (over: Partial<Plan>): Plan => ({ ...(examplePlan() as Plan), ...over });
const step = (ts: string, setpointC: number, level: Plan['steps'][number]['level']): Plan['steps'][number] => ({
  ts,
  roomId: 'bedroom-1',
  hvacMode: 'cool',
  setpointC: celsius(setpointC),
  fanOn: false,
  level,
  batteryTargetSocPct: pct(50),
});

describe('milestonesOf (#311)', () => {
  it('lists the storm and the power coming back from the scenario, in home time, in order', () => {
    const m = milestonesOf({ ...base, outages: [{ fromMs: at('2026-07-17T22:00:00+02:00'), toMs: at('2026-07-18T06:30:00+02:00') }] });
    expect(m).toEqual([
      { kind: 'storm_start', at: '2026-07-17T22:00:00+02:00', label: 'The storm starts: the grid goes down' },
      { kind: 'power_back', at: '2026-07-18T06:30:00+02:00', label: 'Power is back (stable)' },
    ]);
  });

  it('lists power back once the grid has been stable, when the family message is sent', () => {
    const m = milestonesOf({ ...base, outages: [{ fromMs: at('2026-07-17T22:00:00+02:00'), toMs: at('2026-07-18T06:30:00+02:00') }], stableGridMs: 10 * 60_000 });
    expect(m.map((x) => [x.kind, x.at])).toEqual([
      ['storm_start', '2026-07-17T22:00:00+02:00'],
      ['power_back', '2026-07-18T06:40:00+02:00'],
    ]);
  });

  it("takes the plan's own fields: surplus window, last-resort crossing and end, the first essential step", () => {
    const p = plan({
      surplus: { from: '2026-07-18T11:00:00+02:00', to: '2026-07-18T15:30:00+02:00', keptKWh: 2, rooms: [] },
      lastResort: {
        safeUntil: '2026-07-17T23:40:00+02:00',
        safeHours: 3.67,
        limitedBy: 'battery',
        comfortLimitC: celsius(24),
        worstC: celsius(24.7),
        worstAt: '2026-07-18T06:20:00+02:00',
        limitCrossedAt: '2026-07-18T02:15:00+02:00',
        limitCrossedC: celsius(24),
      },
      steps: [
        step('2026-07-17T20:00:00+02:00', 25, 'comfort'),
        step('2026-07-17T21:30:00+02:00', 23.5, 'comfort'),
        step('2026-07-17T23:00:00+02:00', 23.5, 'essential'),
      ],
    });
    const kinds = milestonesOf({ ...base, plan: p }).map((m) => [m.kind, m.at]);
    expect(kinds).toEqual([
      ['pre_cooling_start', '2026-07-17T21:30:00+02:00'],
      ['essential_level', '2026-07-17T23:00:00+02:00'],
      ['last_resort_end', '2026-07-17T23:40:00+02:00'],
      ['limit_crossed', '2026-07-18T02:15:00+02:00'],
      ['surplus_start', '2026-07-18T11:00:00+02:00'],
      ['surplus_end', '2026-07-18T15:30:00+02:00'],
    ]);
  });

  it('only what lies ahead within the horizon; the next recharge when known; at most 12', () => {
    const outages = [
      { fromMs: NOW - 3_600_000, toMs: NOW + 2 * 3_600_000 },
      { fromMs: NOW + 30 * 3_600_000, toMs: NOW + 31 * 3_600_000 },
    ];
    const m = milestonesOf({ ...base, outages, rechargeAtMs: NOW + 12 * 3_600_000 });
    // The storm already started is not a milestone; its end is. The one after the horizon is not listed.
    expect(m.map((x) => x.kind)).toEqual(['power_back', 'next_recharge']);
    const many = Array.from({ length: 20 }, (_, i) => ({ fromMs: NOW + (i + 1) * 600_000, toMs: NOW + (i + 1) * 600_000 + 300_000 }));
    expect(milestonesOf({ ...base, outages: many })).toHaveLength(12);
  });

  it('a moment exactly now is not ahead; two at the same time keep a stable order', () => {
    const m = milestonesOf({ ...base, outages: [{ fromMs: NOW, toMs: NOW + 3_600_000 }], rechargeAtMs: NOW + 3_600_000 });
    expect(m.map((x) => x.kind)).toEqual(['power_back', 'next_recharge']);
  });
});

describe('outagesOf (#311): the grid outages the simulator plays, as instants', () => {
  it('the storm day: the grid is down from 3 to 18.5 hours after its start, the same hours the simulator reads', () => {
    const scenario = builtInScenario('storm-blackout');
    const start = Date.parse(scenario.startAt);
    expect(outagesOf(scenario)).toEqual(scenario.gridOutages.map((o) => ({ fromMs: start + o.fromH * 3_600_000, toMs: start + o.toH * 3_600_000 })));
    expect(outagesOf(scenario).length).toBeGreaterThan(0);
    expect(outagesOf(builtInScenario('clear-day'))).toEqual([]);
  });
});
