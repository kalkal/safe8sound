import { PlanSchema, celsius, type PlanComfortInput } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { planComfort } from '../../src/modules/comfort-plan/plan-comfort.js';
import { planSummary } from '../../src/modules/comfort-plan/summaries.js';
import { world } from './support.js';

// Owner, 22 Oct ("it must match normal use"): a plan the guard refused is said and shown only when the person asked for
// what was refused (the agent says so in the call's _meta: ctx.askedByPerson). A proposal the model made up on its own is
// neither said nor shown: the card and the model's text describe only the plan that holds. Either way the refusal stays in
// the audit trail and in one structured line, without any text.

const greedy: PlanComfortInput = { goal: 'cool', setpointC: celsius(22), roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] };
// Any night window: only whether the text names a refusal matters here.
const OPTS = { nightWindowHours: 8, nightStartHour: 22, nightEndHour: 6, timeZone: 'Europe/Rome' };

describe('a refused proposal, said only when the person asked for it (owner, 22 Oct)', () => {
  it('the model made it up: only the plan that holds, no refusal on the card nor in the text; recorded and logged', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, greedy, w.ctx);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    const plan = PlanSchema.parse(r.value);
    expect(plan.refusedProposal).toBeUndefined();
    expect(plan.guarantees.every((g) => g.ok)).toBe(true);
    expect(planSummary(plan, OPTS)).not.toMatch(/refus/i);
    const rejections = await w.store.listGuardRejections();
    expect(rejections.ok && rejections.value.length).toBe(1);
    const line = w.logger.lines.find((l) => l.details?.['event'] === 'proposal_refused');
    expect(line).toMatchObject({ level: 'info', correlationId: 'test-correlation', code: 'inverter_limit_exceeded', details: { event: 'proposal_refused', askedByPerson: false } });
  });

  it('the person asked for it: the plan that holds says the refusal first, as before; recorded and logged', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, greedy, { ...w.ctx, askedByPerson: true });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    expect(r.value.refusedProposal?.code).toBe('inverter_limit_exceeded');
    expect(planSummary(r.value, OPTS)).toMatch(/^The safety check refused the proposed plan: /);
    const line = w.logger.lines.find((l) => l.details?.['event'] === 'proposal_refused');
    expect(line?.details).toMatchObject({ askedByPerson: true });
  });

  it('the line never carries the refusal text', async () => {
    const w = world('heatwave', 14);
    const r = await planComfort(w.deps, greedy, { ...w.ctx, askedByPerson: true });
    const message = r.ok ? (r.value.refusedProposal?.message ?? '') : '';
    expect(message.length).toBeGreaterThan(0);
    const line = w.logger.lines.find((l) => l.details?.['event'] === 'proposal_refused');
    expect(JSON.stringify(line)).not.toContain(message);
  });
});
