import { ApplyPlanOutputSchema, PlanIdSchema, PreferencesSchema, celsius, err, pct, toolError, type Forecast, type Plan, type Snapshot } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/modules/comfort-plan/apply-plan.js';
import { comfortPlanModule } from '../../src/modules/comfort-plan/index.js';
import { sha256Hex } from '../../src/modules/comfort-plan/confirm-token.js';
import { planComfort } from '../../src/modules/comfort-plan/plan-comfort.js';
import { applySummary } from '../../src/modules/comfort-plan/summaries.js';
import { MIN, REAL, preferences, world } from './support.js';

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

async function proposed(w: ReturnType<typeof world>): Promise<Plan> {
  const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** A cold, dry spell: every forecast hour at 12 °C and 40 % outside. */
const coldSpell = (f: Forecast): Forecast => ({ ...f, hourly: f.hourly.map((h) => ({ ...h, tempOutC: celsius(12), humidityOutPct: pct(40) })) });
const roomsAt = (tempC: number, humidityPct: number) => (s: Snapshot): Snapshot => ({
  ...s,
  rooms: s.rooms.map((r) => ({ ...r, tempC: celsius(tempC), humidityPct: pct(humidityPct) })),
});

const statusOf = async (w: ReturnType<typeof world>, plan: Plan) => {
  const r = await w.store.getPlan(plan.id);
  return r.ok ? r.value.status : undefined;
};

describe('apply_plan (two-phase: confirm)', () => {
  it('judges the expiry on the home clock while the store keeps its wall clock for retention (#175)', async () => {
    // The module plans on a scenario day; the store is months later in real time, as on the Lambda.
    const w = world('heatwave', 14, { storeWallMs: Date.parse('2026-09-30T10:00:00Z') + 400 * 24 * 60 * MIN });
    const plan = await proposed(w);
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(r.ok && r.value.plan.status).toBe('applied');
    w.clock.set(Date.parse(plan.expiresAt));
    const late = await proposed(w);
    w.clock.set(Date.parse(late.expiresAt));
    const refused = await applyPlan(w.deps, { planId: late.id }, w.ctx);
    expect(!refused.ok && refused.error.code).toBe('plan_expired');
  });

  it('applies a proposed plan once the guard revalidates it', async () => {
    const w = world('heatwave', 14);
    const plan = await proposed(w);
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(r.ok && ApplyPlanOutputSchema.parse(r.value)).toMatchObject({ alreadyApplied: false, advisoryOnly: false, manualInstructions: [], plan: { id: plan.id, status: 'applied' } });
    expect(await statusOf(w, plan)).toBe('applied');
  });

  describe('the person confirms before the agent applies (#230)', () => {
    const turn = '3f6c1a9e-8b2d-4c7e-9a1f-2b3c4d5e6f70';
    const later = '9a1f2b3c-4d5e-4f70-8b2d-3f6c1a9e4c7e';

    it('tells the model: never in the turn that proposed the plan', () => {
      const tool = comfortPlanModule(world('heatwave', 14).deps).tools.find((t) => t.name === 'apply_plan');
      expect(tool?.description).toContain('Never in the same turn as plan_comfort: tell the person the plan and wait for their yes.');
    });

    it('records the turn that proposed the plan', async () => {
      const w = world('heatwave', 14);
      const r = await planComfort(w.deps, { goal: 'cool' }, { ...w.ctx, turnId: turn });
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.proposedInTurn).toBe(turn);
      const stored = await w.store.getPlan(r.value.id);
      expect(stored.ok && stored.value.proposedInTurn).toBe(turn);
    });

    it('same turn: refused, nothing applied, and the model is told to ask the person first', async () => {
      const w = world('heatwave', 14);
      const r = await planComfort(w.deps, { goal: 'cool' }, { ...w.ctx, turnId: turn });
      if (!r.ok) throw new Error(r.error.message);
      const applied = await applyPlan(w.deps, { planId: r.value.id }, { ...w.ctx, turnId: turn });
      expect(applied.ok).toBe(false);
      if (applied.ok) return;
      expect(applied.error).toMatchObject({ code: 'confirmation_required', category: 'validation' });
      expect(applied.error.message).toMatch(/ask/i);
      expect(await statusOf(w, r.value)).toBe('proposed');
      // Logged once, with the correlation id: the model tried to apply without the person's yes.
      const lines = w.logger.lines.filter((l) => l.code === 'confirmation_required');
      expect(lines).toEqual([expect.objectContaining({ level: 'warn', correlationId: 'test-correlation', details: expect.objectContaining({ event: 'apply_without_confirmation' }) as unknown })]);
    });

    it('a later turn of the conversation: applied as before', async () => {
      const w = world('heatwave', 14);
      const r = await planComfort(w.deps, { goal: 'cool' }, { ...w.ctx, turnId: turn });
      if (!r.ok) throw new Error(r.error.message);
      const applied = await applyPlan(w.deps, { planId: r.value.id }, { ...w.ctx, turnId: later });
      expect(applied.ok && applied.value.plan.status).toBe('applied');
    });

    it('a card tap (no turn header, even with the same correlation id): applied as before', async () => {
      const w = world('heatwave', 14);
      const r = await planComfort(w.deps, { goal: 'cool' }, { ...w.ctx, correlationId: turn, turnId: turn });
      if (!r.ok) throw new Error(r.error.message);
      const applied = await applyPlan(w.deps, { planId: r.value.id }, { ...w.ctx, correlationId: turn });
      expect(applied.ok && applied.value.plan.status).toBe('applied');
    });
  });

  it('is idempotent by planId: a repeat returns the stored outcome', async () => {
    const w = world('heatwave', 14);
    const plan = await proposed(w);
    const first = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    const again = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(again.ok && again.value.alreadyApplied).toBe(true);
    expect(again.ok && first.ok && again.value.plan).toEqual(first.ok && first.value.plan);
  });

  it('refuses an unknown plan and an expired one', async () => {
    const w = world('heatwave', 14);
    const missing = await applyPlan(w.deps, { planId: PlanIdSchema.parse('plan_nope_0000') }, w.ctx);
    expect(!missing.ok && missing.error.code).toBe('plan_not_found');
    const plan = await proposed(w);
    w.clock.set(Date.parse(plan.expiresAt) + MIN);
    const late = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(!late.ok && late.error.code).toBe('plan_expired');
    expect(await statusOf(w, plan)).toBe('proposed');
  });

  it('refuses on the real home a plan built on simulated data (plan §9.4), changing nothing', async () => {
    const w = world('heatwave', 14, { homeId: REAL, readOnly: true });
    const plan = await proposed(w);
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(!r.ok && r.error).toMatchObject({ code: 'simulated_plan_on_real_home', category: 'forbidden', retryable: false });
    expect(await statusOf(w, plan)).toBe('proposed');
  });

  it('on the real home with live data, stores the plan as advice and returns manual instructions per room', async () => {
    const live = { energy: 'live', rooms: 'live', weather: 'live' } as const;
    const w = world('heatwave', 14, { homeId: REAL, readOnly: true, snapshot: (s) => ({ ...s, origin: live }) });
    const plan = await proposed(w);
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(r.ok && r.value.advisoryOnly).toBe(true);
    expect(r.ok && r.value.manualInstructions[0]?.text).toMatch(/^Bedroom: (cool|dry) at \d+(\.\d)? °C/);
  });

  it('refuses a plan the guard rejects on the current state, and records the rejection', async () => {
    const w = world('heatwave', 14);
    const plan = await proposed(w);
    // Meanwhile the battery ran low: the plan's own targets are now out of reach.
    w.setSnapshot((s) => ({ ...s, batterySocPct: pct(12) }));
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(!r.ok && r.error.category).toBe('guard_rejection');
    expect(await statusOf(w, plan)).toBe('proposed');
    const rejections = await w.store.listGuardRejections();
    expect(rejections.ok && rejections.value[0]?.planId).toBe(plan.id);
  });

  for (const goal of ['auto', 'heat'] as const) {
    it(`revalidates a ${goal} plan in the season it was proposed for: in the cold the heating minimum still holds`, async () => {
      const w = world('clear-day', 6, { forecast: coldSpell, snapshot: roomsAt(19, 50) });
      const planned = await planComfort(w.deps, { goal }, w.ctx);
      if (!planned.ok) throw new Error(planned.error.message);
      expect(planned.value.steps[0]?.hvacMode).toBe('heat');
      // Meanwhile a window was left open: the safe room is too cold to recover within the grace period.
      w.setSnapshot(roomsAt(3, 90));
      const r = await applyPlan(w.deps, { planId: planned.value.id }, w.ctx);
      expect(!r.ok && r.error.message).toMatch(/^The safe room would drop to [\d.]+ °C, below its 18 °C minimum\./);
      expect(await statusOf(w, planned.value)).toBe('proposed');
    });
  }

  it('property: apply_plan is idempotent, however many times it is called', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (times) => {
        const w = world('heatwave', 14);
        const plan = await proposed(w);
        const results = [];
        for (let i = 0; i < times; i++) results.push(await applyPlan(w.deps, { planId: plan.id }, w.ctx));
        const plans = results.map((r) => (r.ok ? r.value.plan : undefined));
        expect(new Set(plans.map((p) => JSON.stringify(p))).size).toBe(1);
        expect(results.filter((r) => r.ok && !r.value.alreadyApplied)).toHaveLength(1);
      }),
      { numRuns: runs(30) },
    );
  }, 120_000);

  it('property: a rejected plan never changes the stored state', async () => {
    let rejected = 0;
    await fc.assert(
      fc.asyncProperty(fc.double({ min: 10, max: 30, noNaN: true }), async (soc) => {
        const w = world('heatwave', 14);
        const plan = await proposed(w);
        const before = await w.store.getPlan(plan.id);
        w.setSnapshot((s) => ({ ...s, batterySocPct: pct(soc) }));
        const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
        fc.pre(!r.ok);
        rejected++;
        expect(await w.store.getPlan(plan.id)).toEqual(before);
      }),
      { numRuns: runs(30) },
    );
    expect(rejected).toBeGreaterThan(0);
  }, 120_000);
});

describe('a last-resort plan: two explicit yeses, the second bound to the plan by a token (#160)', () => {
  const live = { energy: 'live', rooms: 'live', weather: 'live' } as const;
  const stormAt = (soc: number, over: Parameters<typeof world>[2] = {}) =>
    world('storm-blackout', 3, { ...over, snapshot: (s) => ({ ...(over.snapshot ? over.snapshot(s) : s), batterySocPct: pct(soc) }) });
  const lastResort = async (w: ReturnType<typeof world>) => {
    const plan = await proposed(w);
    if (plan.lastResort === undefined) throw new Error('no last resort');
    return plan;
  };
  const firstYes = async (w: ReturnType<typeof world>, plan: Plan) => {
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    if (r.value.confirmation === undefined) throw new Error('no confirmation');
    return { out: r.value, token: r.value.confirmation.token };
  };

  it('the first yes applies nothing: the plan stays proposed and a token comes back, valid at most 10 minutes and never past the plan', async () => {
    const w = stormAt(30);
    const plan = await lastResort(w);
    const { out } = await firstYes(w, plan);
    expect(ApplyPlanOutputSchema.parse(out)).toMatchObject({ alreadyApplied: false, plan: { id: plan.id, status: 'proposed' } });
    expect(out.confirmation?.token).toMatch(/^lr_[A-Za-z0-9_-]{22,64}$/);
    const expiresMs = Date.parse(out.confirmation?.expiresAt ?? '');
    expect(expiresMs).toBeLessThanOrEqual(Date.parse(plan.expiresAt));
    expect(expiresMs).toBeLessThanOrEqual(w.clock.now() + w.deps.config.lastResortConfirmMinutes * MIN);
    expect(await statusOf(w, plan)).toBe('proposed');
  });

  it('the second yes with that token applies it, once', async () => {
    const w = stormAt(30);
    const plan = await lastResort(w);
    const { token } = await firstYes(w, plan);
    const r = await applyPlan(w.deps, { planId: plan.id, lastResortToken: token }, w.ctx);
    expect(r.ok && ApplyPlanOutputSchema.parse(r.value)).toMatchObject({ alreadyApplied: false, plan: { status: 'applied' } });
    expect(r.ok && r.value.confirmation).toBeUndefined();
    expect(await statusOf(w, plan)).toBe('applied');
    const again = await applyPlan(w.deps, { planId: plan.id, lastResortToken: token }, w.ctx);
    expect(again.ok && again.value.alreadyApplied).toBe(true);
  });

  it('a plain yes twice is never the second yes: each one only issues a new token', async () => {
    const w = stormAt(30);
    const plan = await lastResort(w);
    await firstYes(w, plan);
    const second = await firstYes(w, plan);
    expect(second.out.plan.status).toBe('proposed');
    expect(await statusOf(w, plan)).toBe('proposed');
  });

  it('refuses a wrong token, a replaced one and an expired one, applying nothing', async () => {
    const w = stormAt(30);
    const plan = await lastResort(w);
    const wrong = await applyPlan(w.deps, { planId: plan.id, lastResortToken: `lr_${'x'.repeat(32)}` }, w.ctx);
    expect(!wrong.ok && wrong.error).toMatchObject({ code: 'last_resort_token_invalid', category: 'validation' });
    const first = await firstYes(w, plan);
    await firstYes(w, plan);
    const replaced = await applyPlan(w.deps, { planId: plan.id, lastResortToken: first.token }, w.ctx);
    expect(!replaced.ok && replaced.error.code).toBe('last_resort_token_invalid');
    const shortLived = { ...w.deps, config: { ...w.deps.config, lastResortConfirmMinutes: 2 } };
    const late = await applyPlan(shortLived, { planId: plan.id }, w.ctx);
    if (!late.ok || late.value.confirmation === undefined) throw new Error('no confirmation');
    w.clock.set(w.clock.now() + 2 * MIN);
    const expired = await applyPlan(shortLived, { planId: plan.id, lastResortToken: late.value.confirmation.token }, w.ctx);
    expect(!expired.ok && expired.error.code).toBe('last_resort_token_invalid');
    expect(await statusOf(w, plan)).toBe('proposed');
  });

  it('refuses a token whose confirmation was issued for another version of the plan: the token is burnt, nothing applied (#167 review)', async () => {
    const w = stormAt(30);
    const plan = await lastResort(w);
    const token = `lr_${'y'.repeat(32)}`;
    const saved = await w.store.saveLastResortConfirmation({ planId: plan.id, tokenHash: sha256Hex(token), planHash: 'f'.repeat(64), expiresAt: new Date(w.clock.now() + 5 * MIN).toISOString() }, w.clock.now());
    expect(saved.ok).toBe(true);
    const r = await applyPlan(w.deps, { planId: plan.id, lastResortToken: token }, w.ctx);
    expect(!r.ok && r.error.code).toBe('last_resort_token_invalid');
    expect(await w.store.consumeLastResortConfirmation(plan.id, sha256Hex(token), w.clock.now())).toMatchObject({ ok: false });
    expect(await statusOf(w, plan)).toBe('proposed');
  });

  it('never lets the token outlive the plan, nor the configured minutes', async () => {
    const long = stormAt(30);
    const longDeps = { ...long.deps, config: { ...long.deps.config, planTtlMinutes: 60, lastResortConfirmMinutes: 10 } };
    const p1 = await planComfort(longDeps, { goal: 'cool' }, long.ctx);
    if (!p1.ok) throw new Error(p1.error.message);
    const a1 = await applyPlan(longDeps, { planId: p1.value.id }, long.ctx);
    expect(a1.ok && Date.parse(a1.value.confirmation?.expiresAt ?? '')).toBe(long.clock.now() + 10 * MIN);
    const short = stormAt(30);
    const shortDeps = { ...short.deps, config: { ...short.deps.config, planTtlMinutes: 10, lastResortConfirmMinutes: 30 } };
    const p2 = await planComfort(shortDeps, { goal: 'cool' }, short.ctx);
    if (!p2.ok) throw new Error(p2.error.message);
    short.clock.set(short.clock.now() + 4 * MIN);
    const a2 = await applyPlan(shortDeps, { planId: p2.value.id }, short.ctx);
    expect(a2.ok && Date.parse(a2.value.confirmation?.expiresAt ?? '')).toBe(Date.parse(p2.value.expiresAt));
  });

  it('a first yes at a whole second + 500 ms: the time told is the time stored, and the token works until just before it', async () => {
    const w = stormAt(30);
    const deps = { ...w.deps, config: { ...w.deps.config, planTtlMinutes: 60, lastResortConfirmMinutes: 10 } };
    const p = await planComfort(deps, { goal: 'cool' }, w.ctx);
    if (!p.ok) throw new Error(p.error.message);
    const start = w.clock.now() + 500;
    w.clock.set(start);
    const first = await applyPlan(deps, { planId: p.value.id }, w.ctx);
    if (!first.ok || first.value.confirmation === undefined) throw new Error('no confirmation');
    const told = Date.parse(first.value.confirmation.expiresAt);
    expect(told).toBe(start - 500 + 10 * MIN);
    w.clock.set(told);
    const late = await applyPlan(deps, { planId: p.value.id, lastResortToken: first.value.confirmation.token }, w.ctx);
    expect(!late.ok && late.error.code).toBe('last_resort_token_invalid');
    const second = await applyPlan(deps, { planId: p.value.id }, w.ctx);
    if (!second.ok || second.value.confirmation === undefined) throw new Error('no confirmation');
    w.clock.set(Date.parse(second.value.confirmation.expiresAt) - 1);
    const inTime = await applyPlan(deps, { planId: p.value.id, lastResortToken: second.value.confirmation.token }, w.ctx);
    expect(inTime.ok && inTime.value.plan.status).toBe('applied');
  });

  it('a token already used, on a plan applied meanwhile (a stale read, a retry), returns the applied plan (#168 review)', async () => {
    const w = stormAt(30);
    const plan = await lastResort(w);
    const { token } = await firstYes(w, plan);
    expect((await applyPlan(w.deps, { planId: plan.id, lastResortToken: token }, w.ctx)).ok).toBe(true);
    // The retry reads the plan as it was before the first call applied it.
    let stale = true;
    const storeFor: typeof w.deps.storeFor = (h, scope) => {
      const store = w.deps.storeFor(h, scope);
      return new Proxy(store, {
        get: (target, key) => {
          if (key === 'getPlan' && stale) {
            stale = false;
            return () => Promise.resolve({ ok: true as const, value: plan });
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
    const retry = await applyPlan({ ...w.deps, storeFor }, { planId: plan.id, lastResortToken: token }, w.ctx);
    expect(retry.ok && retry.value).toMatchObject({ alreadyApplied: true, plan: { status: 'applied' } });
  });

  describe('the family alert (#160): once, when the plan is really applied', () => {
    const clock = (w: ReturnType<typeof world>, iso: string) =>
      new Intl.DateTimeFormat('en-US', { timeZone: w.profile.location.tz, hour: 'numeric', minute: '2-digit' }).format(Date.parse(iso));

    it('every registered contact gets the fixed text, with until when the plan keeps the safe room safe', async () => {
      const w = stormAt(30);
      const plan = await lastResort(w);
      const { token } = await firstYes(w, plan);
      expect(await w.inbox()).toEqual([]);
      await applyPlan(w.deps, { planId: plan.id, lastResortToken: token }, w.ctx);
      const inbox = await w.inbox();
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ role: 'daughter', channel: 'in_app', transition: 'last_resort_applied' });
      expect(inbox[0]?.text).toContain('the home battery is low');
      expect(inbox[0]?.text).toContain(`until ${clock(w, plan.lastResort?.safeUntil ?? '')}`);
      expect(inbox[0]?.text).toContain('Please check on them.');
      const applied = await w.store.getPlan(plan.id);
      expect(applied.ok && applied.value.status).toBe('applied');
      await applyPlan(w.deps, { planId: plan.id, lastResortToken: token }, w.ctx);
      expect(await w.inbox()).toHaveLength(1);
    });

    it('on the real home too: the alert is a message, not a command to the home, and the person hears it went out', async () => {
      const w = stormAt(30, { homeId: REAL, readOnly: true, snapshot: (s) => ({ ...s, origin: live }) });
      const plan = await lastResort(w);
      const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
      expect((await w.inbox()).map((m) => m.transition)).toEqual(['last_resort_applied']);
      expect(r.ok && r.value.familyAlert).toEqual({ sent: 1, failed: 0 });
      expect(r.ok && applySummary(r.value)).toContain('1 registered family contact was alerted.');
    });

    it('the result says how it went: sent once, nothing on a repeat, failed when the phone is down, zero with no contact', async () => {
      const w = stormAt(30);
      const plan = await lastResort(w);
      const { token } = await firstYes(w, plan);
      const done = await applyPlan(w.deps, { planId: plan.id, lastResortToken: token }, w.ctx);
      expect(done.ok && done.value.familyAlert).toEqual({ sent: 1, failed: 0 });
      const repeat = await applyPlan(w.deps, { planId: plan.id, lastResortToken: token }, w.ctx);
      expect(repeat.ok && repeat.value.familyAlert).toBeUndefined();
      const nobody = stormAt(30, { preferences: PreferencesSchema.parse({ ...preferences, familyContacts: [] }) });
      const p2 = await lastResort(nobody);
      const t2 = await firstYes(nobody, p2);
      const none = await applyPlan(nobody.deps, { planId: p2.id, lastResortToken: t2.token }, nobody.ctx);
      expect(none.ok && none.value.familyAlert).toEqual({ sent: 0, failed: 0 });
      const sent = nobody.logger.lines.find((l) => l.details?.['event'] === 'last_resort_alert_sent');
      expect(sent?.details).toMatchObject({ sent: 0, total: 0 });
    });

    it('a normal plan sends nothing', async () => {
      const w = world('heatwave', 14);
      const plan = await proposed(w);
      await applyPlan(w.deps, { planId: plan.id }, w.ctx);
      expect(await w.inbox()).toEqual([]);
    });

    it('a failed alert does not undo the plan: it is logged as a warning with its code', async () => {
      const down = { send: () => Promise.resolve(err(toolError('store_unavailable', 'The phone is down.'))) };
      const w = stormAt(30, { notifier: down });
      const plan = await lastResort(w);
      const { token } = await firstYes(w, plan);
      const r = await applyPlan(w.deps, { planId: plan.id, lastResortToken: token }, w.ctx);
      expect(r.ok && r.value.plan.status).toBe('applied');
      expect(r.ok && r.value.familyAlert).toEqual({ sent: 0, failed: 1 });
      expect(r.ok && applySummary(r.value)).toContain('The family alert could not be sent to 1 of 1 contacts: call them now.');
      const warn = w.logger.lines.find((l) => l.details?.['event'] === 'last_resort_alert_failed');
      expect(warn).toMatchObject({ level: 'warn', code: 'store_unavailable', category: 'dependency_unavailable', correlationId: 'test-correlation' });
    });
  });

  it('refuses a token on a plan that is not a last resort', async () => {
    const w = world('heatwave', 14);
    const plan = await proposed(w);
    const r = await applyPlan(w.deps, { planId: plan.id, lastResortToken: `lr_${'x'.repeat(32)}` }, w.ctx);
    expect(!r.ok && r.error.code).toBe('last_resort_token_invalid');
    expect(await statusOf(w, plan)).toBe('proposed');
  });

  it('logs that a token was issued and used, never the token itself', async () => {
    const w = stormAt(30);
    const plan = await lastResort(w);
    const { token } = await firstYes(w, plan);
    await applyPlan(w.deps, { planId: plan.id, lastResortToken: token }, w.ctx);
    const text = JSON.stringify(w.logger.lines);
    expect(text).not.toContain('lr_');
    expect(text).not.toContain(token.slice(3));
    const events = w.logger.lines.map((l) => l.details?.['event']).filter((e) => e !== undefined);
    expect(events).toEqual(expect.arrayContaining(['last_resort_confirmation_issued', 'last_resort_confirmed', 'last_resort_applied']));
    expect(w.logger.lines.every((l) => l.correlationId === 'test-correlation')).toBe(true);
  });

  it('on the real home the last resort stays advice: manual steps at once, no token', async () => {
    const w = stormAt(30, { homeId: REAL, readOnly: true, snapshot: (s) => ({ ...s, origin: live }) });
    const plan = await lastResort(w);
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(r.ok && ApplyPlanOutputSchema.parse(r.value)).toMatchObject({ advisoryOnly: true, plan: { status: 'applied' } });
    expect(r.ok && r.value.confirmation).toBeUndefined();
    expect(r.ok && r.value.manualInstructions.length).toBeGreaterThan(0);
  });
});
