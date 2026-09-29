import {
  ConfigChangeSchema,
  HomeIdSchema,
  PlanIdSchema,
  PlanSchema,
  PreferencesSchema,
  type HomeId,
  type Plan,
} from '@cold-reserve/contracts';
import { examplePlan, examplePreferences } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_STORE_TTL, type StateStoreFactory } from '../src/state-store.js';

// Shared contract suite (plan §10.1): every StateStore adapter must pass it unchanged.
// It is re-runnable against a persistent backend (the dev table, later in the main pipeline):
// every test uses fresh random home ids, and every timestamp is relative to the harness start
// time, so real TTL deletion never removes an item a test still needs.

export interface StateStoreHarness {
  /** Builds a store for one home. Calling it again must reach the same backing data. */
  readonly factory: StateStoreFactory;
  /**
   * Moves the clock injected into the adapter (epoch ms). It drives only the adapter's own
   * checks (expiry filter on read, plan expiry on apply), not the backend's TTL deletion.
   */
  setNow(ms: number): void;
  /** Base time of the fixtures (epoch ms, whole seconds). Use Date.now() on a real backend. */
  readonly startMs?: number;
}

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
const DEFAULT_START_MS = Date.parse('2026-07-15T12:00:00Z');

const iso = (ms: number) => new Date(ms).toISOString();
const randomHome = (tag: string): HomeId => HomeIdSchema.parse(`demo#ct${tag}${Math.random().toString(36).slice(2, 12)}`);

export function describeStateStoreContract(name: string, makeHarness: () => StateStoreHarness): void {
  const setup = () => {
    const harness = makeHarness();
    const start = harness.startMs ?? DEFAULT_START_MS;
    harness.setNow(start);
    const plan: Plan = PlanSchema.parse({
      ...examplePlan(),
      createdAt: iso(start),
      expiresAt: iso(start + 10 * MINUTE_MS),
      horizonAt: iso(start + 17 * 60 * MINUTE_MS),
      steps: examplePlan().steps.map((step) => ({ ...step, ts: iso(start + 60 * MINUTE_MS) })),
    });
    return {
      harness,
      start,
      plan,
      homeA: randomHome('a'),
      homeB: randomHome('b'),
      at: (offsetMs: number) => iso(start + offsetMs),
      prefs: () => PreferencesSchema.parse(examplePreferences()),
      change: (offsetMs: number, to: number) =>
        ConfigChangeSchema.parse({ ts: iso(start + offsetMs), field: 'safety.cooling.maxC', from: 27, to, by: 'user', confirmed: true }),
    };
  };

  describe(`StateStore contract: ${name}`, () => {
    describe('preferences', () => {
      it('has none for a new home', async () => {
        const t = setup();
        expect(await t.harness.factory(t.homeA).getPreferences()).toEqual({ ok: true, value: undefined });
      });

      it('returns what was saved', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        expect((await store.putPreferences(t.prefs(), [])).ok).toBe(true);
        expect(await store.getPreferences()).toEqual({ ok: true, value: t.prefs() });
      });

      it('survive a new store instance on the same backing data (a new browser session)', async () => {
        const t = setup();
        await t.harness.factory(t.homeA).putPreferences(t.prefs(), []);
        expect(await t.harness.factory(t.homeA).getPreferences()).toEqual({ ok: true, value: t.prefs() });
      });

      it('are not shared by reference with the caller', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        const saved = t.prefs();
        await store.putPreferences(saved, []);
        saved.roomPriority.push('mutated');
        const read = await store.getPreferences();
        expect(read.ok && read.value?.roomPriority).toEqual(t.prefs().roomPriority);
      });

      it('record every confirmed change, oldest first, readable until their retention ends', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        const first = t.change(0, 28);
        const second = t.change(5 * MINUTE_MS, 26);
        await store.putPreferences(t.prefs(), [first]);
        await store.putPreferences(t.prefs(), [second]);
        expect(await store.listConfigChanges()).toEqual({ ok: true, value: [first, second] });

        const retention = DEFAULT_STATE_STORE_TTL.configChangeDays * DAY_MS;
        t.harness.setNow(t.start + retention - 1);
        expect(await store.listConfigChanges()).toEqual({ ok: true, value: [first, second] });
        t.harness.setNow(t.start + 5 * MINUTE_MS + retention);
        expect(await store.listConfigChanges()).toEqual({ ok: true, value: [] });
      });
    });

    describe('preferences and their log are written together', () => {
      it('rejects a change with an unreadable time and saves nothing', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.putPreferences(t.prefs(), []);
        const changed = { ...t.prefs(), language: 'it-IT' as const };
        const bad = { ...t.change(0, 28), ts: 'yesterday' };
        expect(await store.putPreferences(changed, [bad])).toMatchObject({ ok: false, error: { code: 'invalid_input', details: { field: 'changes' } } });
        expect(await store.getPreferences()).toEqual({ ok: true, value: t.prefs() });
        expect(await store.listConfigChanges()).toEqual({ ok: true, value: [] });
      });
    });

    describe('home scoping', () => {
      it('never shows one home the data of another', async () => {
        const t = setup();
        const a = t.harness.factory(t.homeA);
        await a.putPreferences(t.prefs(), [t.change(0, 28)]);
        await a.savePlan(t.plan);
        await a.recordGuardRejection({ at: t.at(0), failed: ['storm_reserve'] });

        const b = t.harness.factory(t.homeB);
        expect(b.homeId).toBe(t.homeB);
        expect(await b.getPreferences()).toEqual({ ok: true, value: undefined });
        expect(await b.listConfigChanges()).toEqual({ ok: true, value: [] });
        expect(await b.getPlan(t.plan.id)).toMatchObject({ ok: false, error: { code: 'plan_not_found' } });
        expect(await b.applyPlan(t.plan.id)).toMatchObject({ ok: false, error: { code: 'plan_not_found' } });
        expect(await b.listGuardRejections()).toEqual({ ok: true, value: [] });
      });
    });

    describe('plans', () => {
      it('returns a saved plan and refuses to overwrite its id', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        expect((await store.savePlan(t.plan)).ok).toBe(true);
        expect(await store.getPlan(t.plan.id)).toEqual({ ok: true, value: t.plan });
        expect(await store.savePlan(t.plan)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      });

      it('reports an unknown plan as plan_not_found', async () => {
        const t = setup();
        const unknown = PlanIdSchema.parse('plan_unknown00');
        expect(await t.harness.factory(t.homeA).getPlan(unknown)).toMatchObject({ ok: false, error: { code: 'plan_not_found' } });
      });

      it('applies a proposed plan once; applying again returns the original outcome', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.savePlan(t.plan);
        expect(await store.applyPlan(t.plan.id)).toMatchObject({ ok: true, value: { alreadyApplied: false, plan: { status: 'applied' } } });
        expect(await store.applyPlan(t.plan.id)).toMatchObject({ ok: true, value: { alreadyApplied: true, plan: { status: 'applied' } } });
        expect(await store.getPlan(t.plan.id)).toMatchObject({ ok: true, value: { status: 'applied' } });
      });

      it('lets exactly one of two concurrent applies win (conditional write)', async () => {
        const t = setup();
        await t.harness.factory(t.homeA).savePlan(t.plan);
        const results = await Promise.all([t.harness.factory(t.homeA).applyPlan(t.plan.id), t.harness.factory(t.homeA).applyPlan(t.plan.id)]);
        expect(results.every((r) => r.ok)).toBe(true);
        expect(results.filter((r) => r.ok && !r.value.alreadyApplied)).toHaveLength(1);
      });

      it('applies until the last millisecond before expiry, then refuses with plan_expired', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.savePlan(t.plan);
        t.harness.setNow(Date.parse(t.plan.expiresAt));
        expect(await store.applyPlan(t.plan.id)).toMatchObject({ ok: false, error: { code: 'plan_expired', category: 'validation' } });
        t.harness.setNow(Date.parse(t.plan.expiresAt) - 1);
        expect(await store.applyPlan(t.plan.id)).toMatchObject({ ok: true, value: { alreadyApplied: false } });
      });

      it('keeps plans readable until the plan retention (TTL) ends', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.savePlan(t.plan);
        const end = t.start + DEFAULT_STATE_STORE_TTL.planDays * DAY_MS;
        t.harness.setNow(end - 1);
        expect((await store.getPlan(t.plan.id)).ok).toBe(true);
        t.harness.setNow(end);
        expect(await store.getPlan(t.plan.id)).toMatchObject({ ok: false, error: { code: 'plan_not_found' } });
      });
    });

    describe('guard rejection log', () => {
      it('lists rejections newest first and survives a new store instance', async () => {
        const t = setup();
        const older = { at: t.at(0), failed: ['storm_reserve'] as const };
        const newer = { at: t.at(MINUTE_MS), failed: ['inverter_limit', 'battery_power'] as const, planId: t.plan.id };
        await t.harness.factory(t.homeA).recordGuardRejection(older);
        await t.harness.factory(t.homeA).recordGuardRejection(newer);
        expect(await t.harness.factory(t.homeA).listGuardRejections()).toEqual({ ok: true, value: [newer, older] });
      });

      it('keeps rejections readable until their retention (TTL) ends', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.recordGuardRejection({ at: t.at(0), failed: ['pacing_on_track'] });
        const end = t.start + DEFAULT_STATE_STORE_TTL.guardRejectionDays * DAY_MS;
        t.harness.setNow(end - 1);
        expect(await store.listGuardRejections()).toMatchObject({ ok: true, value: [{ failed: ['pacing_on_track'] }] });
        t.harness.setNow(end);
        expect(await store.listGuardRejections()).toEqual({ ok: true, value: [] });
      });

      it('rejects an entry without failed guarantees or with an unreadable time', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        expect(await store.recordGuardRejection({ at: t.at(0), failed: [] })).toMatchObject({
          ok: false,
          error: { code: 'invalid_input', details: { field: 'failed' } },
        });
        expect(await store.recordGuardRejection({ at: 'yesterday', failed: ['storm_reserve'] })).toMatchObject({
          ok: false,
          error: { code: 'invalid_input', details: { field: 'at' } },
        });
        expect(await store.listGuardRejections()).toEqual({ ok: true, value: [] });
      });
    });
  });
}
