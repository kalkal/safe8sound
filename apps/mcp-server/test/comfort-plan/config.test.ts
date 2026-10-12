import { describe, expect, it } from 'vitest';
import raw from '../../config/comfort-plan.json' with { type: 'json' };
import { parseComfortPlanConfig } from '../../src/modules/comfort-plan/config.js';

describe('comfort-plan config', () => {
  it('parses the default file', () => {
    const c = parseComfortPlanConfig(raw);
    expect(c.ok && c.value.planner.dutyCycles[0]).toEqual({ onMinutes: 40, periodMinutes: 60 });
  });

  it('refuses a cycle that runs longer than its period, and names the field', () => {
    const c = parseComfortPlanConfig({ ...raw, planner: { ...raw.planner, dutyCycles: [{ onMinutes: 70, periodMinutes: 60 }] } });
    expect(!c.ok && c.error).toMatchObject({ code: 'invalid_config', details: { issues: [{ path: 'planner.dutyCycles.0' }] } });
  });

  it('refuses offsets that do not grow from comfort to saver', () => {
    const c = parseComfortPlanConfig({ ...raw, planner: { ...raw.planner, levelOffsetK: { comfort: 0, balanced: 2, saver: 1 } } });
    expect(c.ok).toBe(false);
  });

  it('reads the humidity band and refuses one whose lower edge is not below the upper', () => {
    const c = parseComfortPlanConfig(raw);
    expect(c.ok && c.value.planner.humidityBand).toEqual({ dryOnPct: 55, dryOffPct: 45, marginPct: 3 });
    const wrong = parseComfortPlanConfig({ ...raw, planner: { ...raw.planner, humidityBand: { dryOnPct: 50, dryOffPct: 50, marginPct: 3 } } });
    expect(!wrong.ok && wrong.error.details?.issues?.[0]?.path).toBe('planner.humidityBand');
  });

  it('reads the level loads of the reserve outlook and refuses them out of order', () => {
    const c = parseComfortPlanConfig(raw);
    expect(c.ok && c.value.outlook.levelLoadW).toEqual({ comfort: 1200, balanced: 900, saver: 650 });
    const wrong = parseComfortPlanConfig({ ...raw, outlook: { levelLoadW: { comfort: 500, balanced: 900, saver: 650 } } });
    expect(!wrong.ok && wrong.error.details?.issues?.[0]?.path).toBe('outlook.levelLoadW');
  });

  it('reads the household-tip options, longest cycle first, and refuses a washing option without a cycle or a mean above its peak (#219)', () => {
    const c = parseComfortPlanConfig(raw);
    expect(c.ok && c.value.planner.householdTip.options.map((o) => o.cycle ?? o.load)).toEqual(['eco', 'normal', 'quick', 'cooking']);
    const [eco] = raw.planner.householdTip.options;
    const tip = (o: object) => parseComfortPlanConfig({ ...raw, planner: { ...raw.planner, householdTip: { options: [{ ...eco, ...o }] } } });
    expect(tip({ cycle: undefined }).ok).toBe(false);
    expect(tip({ meanW: 3_000 }).ok).toBe(false);
    expect(tip({ load: 'cooking', cycle: undefined }).ok).toBe(true);
  });
});
