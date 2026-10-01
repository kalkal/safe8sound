import { celsius, pct, type PlanComfortInput } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/modules/comfort-plan/apply-plan.js';
import { planComfort } from '../../src/modules/comfort-plan/plan-comfort.js';
import { world } from './support.js';

// Logs and the store on the comfort-plan paths (audit L1 and L5, #111): the guard's refusal always reaches the
// model, a store that cannot log it is said in the log with the request's correlation id, and every store the
// module opens knows that id.

const greedy: PlanComfortInput = { goal: 'cool', setpointC: celsius(22), roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] };

describe('comfort-plan logging', () => {
  it('plan_comfort: the refusal wins over a store that cannot log it, and the failure is logged with its correlation id', async () => {
    const w = world('heatwave', 14, { failRejections: true });
    const r = await planComfort(w.deps, greedy, w.ctx);
    expect(!r.ok && r.error.code).toBe('inverter_limit_exceeded');
    expect(w.logger.lines).toContainEqual(
      expect.objectContaining({ level: 'warn', component: 'mcp-server', code: 'store_unavailable', category: 'dependency_unavailable', correlationId: 'test-correlation', homeId: 'demo' }),
    );
  });

  it('apply_plan: the same, when the plan no longer holds at apply time', async () => {
    const w = world('heatwave', 14, { failRejections: true });
    const planned = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!planned.ok) throw new Error(planned.error.message);
    w.setSnapshot((s) => ({ ...s, batterySocPct: pct(12) }));
    const r = await applyPlan(w.deps, { planId: planned.value.id }, w.ctx);
    expect(!r.ok && r.error.category).toBe('guard_rejection');
    expect(w.logger.lines.some((l) => l.code === 'store_unavailable' && l.correlationId === 'test-correlation')).toBe(true);
  });

  it('a last resort leaves an audit trail: the refusal in the store and an info line in the log', async () => {
    const w = world('storm-blackout', 3, { snapshot: (s) => ({ ...s, batterySocPct: pct(35) }) });
    const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.lastResort).toBeDefined();
    const logged = await w.store.listGuardRejections();
    expect(logged.ok && logged.value.length).toBeGreaterThan(0);
    const info = w.logger.lines.find((l) => l.level === 'info' && l.details?.['planId'] === r.value.id);
    expect(info?.correlationId).toBe('test-correlation');
  });

  it('every store the module opens knows the correlation id of the request', async () => {
    const w = world('heatwave', 14);
    w.scopes.length = 0;
    const planned = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    if (!planned.ok) throw new Error(planned.error.message);
    await applyPlan(w.deps, { planId: planned.value.id }, w.ctx);
    expect(w.scopes.length).toBeGreaterThan(0);
    expect(w.scopes.every((s) => s?.correlationId === 'test-correlation')).toBe(true);
  });
});
