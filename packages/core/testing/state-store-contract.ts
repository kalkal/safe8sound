import {
  AdminSettingsSchema,
  ConfigChangeSchema,
  SandboxSettingsSchema,
  type AdminSettings,
  type SandboxSettings,
  HomeIdSchema,
  InboxMessageSchema,
  PlanIdSchema,
  PlanSchema,
  PreferencesSchema,
  StormSessionSchema,
  type HomeId,
  type NewInboxMessage,
  type StormMessageText,
  type Plan,
  type StormSession,
} from '@cold-reserve/contracts';
import { examplePlan, examplePreferences } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_STORE_TTL, type LastResortConfirmation, type StateStoreFactory } from '../src/state-store.js';

// Shared contract suite (plan §10.1): every StateStore adapter must pass it unchanged.
// It is re-runnable against a persistent backend (the dev table, later in the main pipeline):
// every test uses fresh random home ids, and every timestamp is relative to the harness start
// time, so real TTL deletion never removes an item a test still needs.

export interface StateStoreHarness {
  /** Builds a store for one home. Calling it again must reach the same backing data. */
  readonly factory: StateStoreFactory;
  /**
   * Moves the wall clock injected into the adapter (epoch ms). It drives only the retention: the TTL written
   * and the expiry filter on read, not the backend's TTL deletion. The domain "now" of a plan's or a
   * confirmation's expiry is passed with each call instead (#175): on a scenario clock it is not the wall.
   */
  setNow(ms: number): void;
  /** Base time of the fixtures (epoch ms, whole seconds). Use Date.now() on a real backend. */
  readonly startMs?: number;
  /**
   * The backend is a real table other things use (the dev table, after a deploy): the suite then skips the
   * admin config test, which would overwrite the one config every home reads (review of #216).
   */
  readonly sharedBackend?: boolean;
}

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
const DEFAULT_START_MS = Date.parse('2026-07-15T12:00:00Z');

const iso = (ms: number) => new Date(ms).toISOString();
// Test-only stand-in for a rendered template (the store suite runs without @cold-reserve/i18n).
// eslint-disable-next-line no-restricted-syntax -- the stores are tested without the templates
const rendered = (text: string) => text as unknown as StormMessageText;
const message = (t: { at: (offsetMs: number) => string }, offsetMs: number, text: string): NewInboxMessage => ({
  ...InboxMessageSchema.parse({ at: t.at(offsetMs), role: 'daughter', channel: 'in_app', transition: 'storm_started', text }),
  text: rendered(text),
});
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
      storm: (home: HomeId, id: string, offsetMs: number, phase: 'prepare' | 'active' = 'prepare'): StormSession =>
        StormSessionSchema.parse({
          schemaVersion: 1,
          id,
          homeId: home,
          phase,
          trigger: 'user',
          startedAt: iso(start + offsetMs),
          ...(phase === 'active' ? { activeAt: iso(start + offsetMs) } : {}),
          safeRoomId: 'bedroom-1',
          occupantRoles: ['grandpa'],
          hoursAtEssential: 18,
          notifications: [],
        }),
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

      it('accepts up to 99 changes at once (one DynamoDB transaction) and refuses more, saving nothing', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        const many = (n: number) => Array.from({ length: n }, (_, i) => t.change(i, 28));
        expect((await store.putPreferences(t.prefs(), many(99))).ok).toBe(true);
        const other = t.harness.factory(t.homeB);
        expect(await other.putPreferences(t.prefs(), many(100))).toMatchObject({ ok: false, error: { code: 'invalid_input', details: { field: 'changes' } } });
        expect(await other.getPreferences()).toEqual({ ok: true, value: undefined });
      });
    });

    describe('storm sessions', () => {
      it('has none for a new home, and returns the latest saved one', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        expect(await store.getLatestStormSession()).toEqual({ ok: true, value: undefined });
        const first = t.storm(t.homeA, 'storm_first00001', 0);
        const second = t.storm(t.homeA, 'storm_second0001', 60 * MINUTE_MS);
        expect((await store.saveStormSession(first)).ok).toBe(true);
        expect((await store.saveStormSession(second)).ok).toBe(true);
        expect(await store.getLatestStormSession()).toEqual({ ok: true, value: second });
      });

      it('claims a storm alert once with its session (#379, #387): of two store clients at once only one writes; another key or home is free', async () => {
        const t = setup();
        const key = 'storm_started#2026-07-17T01:00:00.000Z';
        const mine = t.storm(t.homeA, 'storm_claimmine01', 0);
        const theirs = t.storm(t.homeA, 'storm_claimtheirs', 1);
        const both = await Promise.all([t.harness.factory(t.homeA).claimStormSession(mine, key), t.harness.factory(t.homeA).claimStormSession(theirs, key)]);
        expect(both.map((r) => (r.ok ? r.value : r.error.code)).sort()).toEqual([false, true]);
        // The winner's session is saved with its claim; the loser wrote nothing.
        const [first] = both;
        const winner = first.ok && first.value ? mine : theirs;
        expect(await t.harness.factory(t.homeA).getLatestStormSession()).toEqual({ ok: true, value: winner });
        const late = t.storm(t.homeA, 'storm_claimlate01', 2);
        expect(await t.harness.factory(t.homeA).claimStormSession(late, key)).toEqual({ ok: true, value: false });
        expect(await t.harness.factory(t.homeA).getLatestStormSession()).toEqual({ ok: true, value: winner });
        // The same session, ended, under the power-back claim: replaced in place.
        const ended = StormSessionSchema.parse({ ...winner, phase: 'ended', endedAt: t.at(5 * MINUTE_MS) });
        expect(await t.harness.factory(t.homeA).claimStormSession(ended, 'power_back#2026-07-17T01:00:00.000Z')).toEqual({ ok: true, value: true });
        expect(await t.harness.factory(t.homeA).getLatestStormSession()).toEqual({ ok: true, value: ended });
        expect(await t.harness.factory(t.homeB).claimStormSession(t.storm(t.homeB, 'storm_claimhomeb1', 0), key)).toEqual({ ok: true, value: true });
        expect(await t.harness.factory(t.homeA).claimStormSession(late, '')).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(await t.harness.factory(t.homeA).claimStormSession(t.storm(t.homeB, 'storm_claimwrong1', 0), 'other')).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      });

      it('updates a session in place (same id) and survives a new store instance', async () => {
        const t = setup();
        const prepared = t.storm(t.homeA, 'storm_update0001', 0);
        await t.harness.factory(t.homeA).saveStormSession(prepared);
        const active = StormSessionSchema.parse({ ...prepared, phase: 'active', activeAt: t.at(5 * MINUTE_MS) });
        await t.harness.factory(t.homeA).saveStormSession(active);
        expect(await t.harness.factory(t.homeA).getLatestStormSession()).toEqual({ ok: true, value: active });
      });

      it('never shows one home the storm of another, and refuses a session of another home', async () => {
        const t = setup();
        await t.harness.factory(t.homeA).saveStormSession(t.storm(t.homeA, 'storm_scoped0001', 0));
        expect(await t.harness.factory(t.homeB).getLatestStormSession()).toEqual({ ok: true, value: undefined });
        expect(await t.harness.factory(t.homeB).saveStormSession(t.storm(t.homeA, 'storm_foreign001', 0))).toMatchObject({
          ok: false,
          error: { code: 'invalid_input', details: { field: 'homeId' } },
        });
      });

      it('keeps a session readable until its retention (TTL) ends', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.saveStormSession(t.storm(t.homeA, 'storm_expiry0001', 0));
        const end = t.start + DEFAULT_STATE_STORE_TTL.stormSessionDays * DAY_MS;
        t.harness.setNow(end - 1);
        expect((await store.getLatestStormSession()).ok && (await store.getLatestStormSession())).toMatchObject({ value: { id: 'storm_expiry0001' } });
        t.harness.setNow(end);
        expect(await store.getLatestStormSession()).toEqual({ ok: true, value: undefined });
      });
    });
    describe('family inbox (the phone, #24)', () => {

      it('lists the messages newest first, up to the limit, and keeps two sent at the same time', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        expect(await store.listInbox(10)).toEqual({ ok: true, value: [] });
        const sent = [message(t, 0, 'first'), message(t, MINUTE_MS, 'second'), message(t, MINUTE_MS, 'second again'), message(t, 2 * MINUTE_MS, 'third')];
        for (const m of sent) expect((await store.saveInboxMessage(m)).ok).toBe(true);
        const all = await store.listInbox(10);
        const texts = all.ok ? all.value.map((m) => m.text) : [];
        expect(texts[0]).toBe('third');
        expect(texts.slice(1, 3).sort()).toEqual(['second', 'second again']);
        expect(texts[3]).toBe('first');
        const two = await store.listInbox(2);
        expect(two.ok && two.value.map((m) => m.text)[0]).toBe('third');
        expect(two.ok && two.value).toHaveLength(2);
      });

      it('refuses a message that breaks its contract, and writes nothing', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        expect(await store.saveInboxMessage({ ...message(t, 0, 'ok'), at: 'yesterday' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(await store.saveInboxMessage({ ...message(t, 0, 'ok'), text: rendered('') })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(await store.listInbox(10)).toEqual({ ok: true, value: [] });
      });

      it('never shows one home the messages of another', async () => {
        const t = setup();
        await t.harness.factory(t.homeA).saveInboxMessage(message(t, 0, 'for home A'));
        expect(await t.harness.factory(t.homeB).listInbox(10)).toEqual({ ok: true, value: [] });
      });

      it('keeps a message readable until its retention (TTL) ends', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.saveInboxMessage(message(t, 0, 'short-lived'));
        const end = t.start + DEFAULT_STATE_STORE_TTL.inboxDays * DAY_MS;
        t.harness.setNow(end - 1);
        expect((await store.listInbox(10)).ok && (await store.listInbox(10))).toMatchObject({ value: [{ text: 'short-lived' }] });
        t.harness.setNow(end);
        expect(await store.listInbox(10)).toEqual({ ok: true, value: [] });
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
        expect(await b.applyPlan(t.plan.id, t.start)).toMatchObject({ ok: false, error: { code: 'plan_not_found' } });
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
        expect(await store.applyPlan(t.plan.id, t.start)).toMatchObject({ ok: true, value: { alreadyApplied: false, plan: { status: 'applied' } } });
        expect(await store.applyPlan(t.plan.id, t.start)).toMatchObject({ ok: true, value: { alreadyApplied: true, plan: { status: 'applied' } } });
        expect(await store.getPlan(t.plan.id)).toMatchObject({ ok: true, value: { status: 'applied' } });
      });

      it('lets exactly one of two concurrent applies win (conditional write)', async () => {
        const t = setup();
        await t.harness.factory(t.homeA).savePlan(t.plan);
        const results = await Promise.all([t.harness.factory(t.homeA).applyPlan(t.plan.id, t.start), t.harness.factory(t.homeA).applyPlan(t.plan.id, t.start)]);
        expect(results.every((r) => r.ok)).toBe(true);
        expect(results.filter((r) => r.ok && !r.value.alreadyApplied)).toHaveLength(1);
      });

      it('applies until the last millisecond before expiry, then refuses with plan_expired', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.savePlan(t.plan);
        expect(await store.applyPlan(t.plan.id, Date.parse(t.plan.expiresAt))).toMatchObject({ ok: false, error: { code: 'plan_expired', category: 'validation' } });
        expect(await store.applyPlan(t.plan.id, Date.parse(t.plan.expiresAt) - 1)).toMatchObject({ ok: true, value: { alreadyApplied: false } });
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

    describe('last-resort confirmations (#160)', () => {
      const HASH_A = 'a'.repeat(64);
      const HASH_B = 'b'.repeat(64);
      const PLAN_HASH = 'c'.repeat(64);
      const confirmation = (t: ReturnType<typeof setup>, over: Partial<LastResortConfirmation> = {}): LastResortConfirmation => ({
        planId: t.plan.id,
        tokenHash: HASH_A,
        planHash: PLAN_HASH,
        expiresAt: t.at(5 * MINUTE_MS),
        ...over,
      });

      it('consumes a saved confirmation once, from any store instance, and returns it', async () => {
        const t = setup();
        expect((await t.harness.factory(t.homeA).saveLastResortConfirmation(confirmation(t), t.start)).ok).toBe(true);
        expect(await t.harness.factory(t.homeA).consumeLastResortConfirmation(t.plan.id, HASH_A, t.start)).toEqual({ ok: true, value: confirmation(t) });
        expect(await t.harness.factory(t.homeA).consumeLastResortConfirmation(t.plan.id, HASH_A, t.start)).toMatchObject({
          ok: false,
          error: { code: 'last_resort_token_invalid', category: 'validation' },
        });
      });

      it('refuses a wrong token and keeps the right one usable', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.saveLastResortConfirmation(confirmation(t), t.start);
        expect(await store.consumeLastResortConfirmation(t.plan.id, HASH_B, t.start)).toMatchObject({ ok: false, error: { code: 'last_resort_token_invalid' } });
        expect((await store.consumeLastResortConfirmation(t.plan.id, HASH_A, t.start)).ok).toBe(true);
      });

      it('a new confirmation of the same plan replaces the earlier one', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.saveLastResortConfirmation(confirmation(t), t.start);
        await store.saveLastResortConfirmation(confirmation(t, { tokenHash: HASH_B }), t.start);
        expect(await store.consumeLastResortConfirmation(t.plan.id, HASH_A, t.start)).toMatchObject({ ok: false, error: { code: 'last_resort_token_invalid' } });
        expect((await store.consumeLastResortConfirmation(t.plan.id, HASH_B, t.start)).ok).toBe(true);
      });

      it('works until the last millisecond before it expires', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.saveLastResortConfirmation(confirmation(t), t.start);
        expect(await store.consumeLastResortConfirmation(t.plan.id, HASH_A, t.start + 5 * MINUTE_MS)).toMatchObject({ ok: false, error: { code: 'last_resort_token_invalid' } });
        expect((await store.consumeLastResortConfirmation(t.plan.id, HASH_A, t.start + 5 * MINUTE_MS - 1)).ok).toBe(true);
      });

      it('lets exactly one of two concurrent uses win (conditional write)', async () => {
        const t = setup();
        await t.harness.factory(t.homeA).saveLastResortConfirmation(confirmation(t), t.start);
        const results = await Promise.all([
          t.harness.factory(t.homeA).consumeLastResortConfirmation(t.plan.id, HASH_A, t.start),
          t.harness.factory(t.homeA).consumeLastResortConfirmation(t.plan.id, HASH_A, t.start),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
      });

      it('never lets one home use the confirmation of another, and knows no confirmation for an unknown plan', async () => {
        const t = setup();
        await t.harness.factory(t.homeA).saveLastResortConfirmation(confirmation(t), t.start);
        expect(await t.harness.factory(t.homeB).consumeLastResortConfirmation(t.plan.id, HASH_A, t.start)).toMatchObject({ ok: false, error: { code: 'last_resort_token_invalid' } });
        const unknown = PlanIdSchema.parse('plan_unknown00');
        expect(await t.harness.factory(t.homeA).consumeLastResortConfirmation(unknown, HASH_A, t.start)).toMatchObject({ ok: false, error: { code: 'last_resort_token_invalid' } });
        expect((await t.harness.factory(t.homeA).consumeLastResortConfirmation(t.plan.id, HASH_A, t.start)).ok).toBe(true);
      });

      it('refuses a malformed confirmation and saves nothing', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        expect(await store.saveLastResortConfirmation(confirmation(t, { tokenHash: 'lr_plain-token' }), t.start)).toMatchObject({
          ok: false,
          error: { code: 'invalid_input', details: { field: 'tokenHash' } },
        });
        expect(await store.saveLastResortConfirmation(confirmation(t, { expiresAt: 'soon' }), t.start)).toMatchObject({
          ok: false,
          error: { code: 'invalid_input', details: { field: 'expiresAt' } },
        });
        expect(await store.consumeLastResortConfirmation(t.plan.id, 'lr_plain-token', t.start)).toMatchObject({ ok: false, error: { code: 'last_resort_token_invalid' } });
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

    describe('two clocks: domain times on the scenario clock, retention on the wall (#175)', () => {
      // A scenario plays a day of another year: its times are months before the wall clock.
      const SCENARIO_LAG_MS = 400 * DAY_MS;
      const scenarioPlan = (t: ReturnType<typeof setup>, domainMs: number): Plan =>
        PlanSchema.parse({
          ...t.plan,
          createdAt: iso(domainMs),
          expiresAt: iso(domainMs + 10 * MINUTE_MS),
          horizonAt: iso(domainMs + 17 * 60 * MINUTE_MS),
          steps: t.plan.steps.map((step) => ({ ...step, ts: iso(domainMs + 60 * MINUTE_MS) })),
        });

      it('keeps a plan made at a scenario time for its retention from the write, and applies it on scenario time', async () => {
        const t = setup();
        const domain = t.start - SCENARIO_LAG_MS;
        const plan = scenarioPlan(t, domain);
        const store = t.harness.factory(t.homeA);
        await store.savePlan(plan);
        expect(await store.applyPlan(plan.id, domain + 10 * MINUTE_MS - 1)).toMatchObject({ ok: true, value: { alreadyApplied: false } });
        t.harness.setNow(t.start + DEFAULT_STATE_STORE_TTL.planDays * DAY_MS - 1);
        expect((await store.getPlan(plan.id)).ok).toBe(true);
        t.harness.setNow(t.start + DEFAULT_STATE_STORE_TTL.planDays * DAY_MS);
        expect(await store.getPlan(plan.id)).toMatchObject({ ok: false, error: { code: 'plan_not_found' } });
      });

      it('refuses a plan past its expiry on scenario time, whatever the wall clock says', async () => {
        const t = setup();
        const domain = t.start - SCENARIO_LAG_MS;
        const plan = scenarioPlan(t, domain);
        const store = t.harness.factory(t.homeA);
        await store.savePlan(plan);
        expect(await store.applyPlan(plan.id, domain + 10 * MINUTE_MS)).toMatchObject({ ok: false, error: { code: 'plan_expired' } });
      });

      it('keeps logs, storm sessions and family messages stamped at a scenario time for their retention from the write', async () => {
        const t = setup();
        const domain = -SCENARIO_LAG_MS;
        const store = t.harness.factory(t.homeA);
        await store.putPreferences(t.prefs(), [t.change(domain, 26)]);
        await store.saveStormSession(t.storm(t.homeA, 'storm_scenario01', domain));
        await store.recordGuardRejection({ at: t.at(domain), failed: ['pacing_on_track'] });
        await store.saveInboxMessage(message(t, domain, 'from the scenario day'));
        const inboxEnd = t.start + DEFAULT_STATE_STORE_TTL.inboxDays * DAY_MS;
        t.harness.setNow(inboxEnd - 1);
        expect(await store.listConfigChanges()).toMatchObject({ ok: true, value: [{ to: 26 }] });
        expect(await store.getLatestStormSession()).toMatchObject({ ok: true, value: { id: 'storm_scenario01' } });
        expect(await store.listGuardRejections()).toMatchObject({ ok: true, value: [{ failed: ['pacing_on_track'] }] });
        expect(await store.listInbox(10)).toMatchObject({ ok: true, value: [{ text: 'from the scenario day' }] });
        t.harness.setNow(inboxEnd);
        expect(await store.listInbox(10)).toEqual({ ok: true, value: [] });
        expect(await store.getLatestStormSession()).toMatchObject({ ok: true, value: { id: 'storm_scenario01' } });
      });

      it('lets a last-resort confirmation issued at a scenario time work until it expires on scenario time', async () => {
        const t = setup();
        const domain = t.start - SCENARIO_LAG_MS;
        const store = t.harness.factory(t.homeA);
        const issued: LastResortConfirmation = { planId: t.plan.id, tokenHash: 'a'.repeat(64), planHash: 'c'.repeat(64), expiresAt: iso(domain + 5 * MINUTE_MS) };
        await store.saveLastResortConfirmation(issued, domain);
        t.harness.setNow(t.start + MINUTE_MS);
        expect(await store.consumeLastResortConfirmation(t.plan.id, issued.tokenHash, domain + 5 * MINUTE_MS)).toMatchObject({ ok: false, error: { code: 'last_resort_token_invalid' } });
        expect(await store.consumeLastResortConfirmation(t.plan.id, issued.tokenHash, domain + 5 * MINUTE_MS - 1)).toEqual({ ok: true, value: issued });
      });
    });

    describe('a scenario day that replays (daily anchor): scenario time rewinds, the wall never does (#175 review)', () => {
      it('a plan lives at most its own lifetime on the wall clock from its write, even if scenario time rewinds', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.savePlan(t.plan);
        // Ten wall minutes later scenario time has rewound to before the plan's expiry: the wall bound still holds.
        t.harness.setNow(t.start + 10 * MINUTE_MS);
        expect(await store.applyPlan(t.plan.id, t.start + 5 * MINUTE_MS)).toMatchObject({ ok: false, error: { code: 'plan_expired' } });
        t.harness.setNow(t.start + 10 * MINUTE_MS - 1);
        expect(await store.applyPlan(t.plan.id, t.start + 5 * MINUTE_MS)).toMatchObject({ ok: true, value: { alreadyApplied: false } });
      });

      it('a confirmation lives at most its own lifetime on the wall clock from its issue, even if scenario time rewinds', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        // Issued at scenario time start + 1 min, valid until start + 5 min: four minutes.
        await store.saveLastResortConfirmation({ planId: t.plan.id, tokenHash: 'a'.repeat(64), planHash: 'c'.repeat(64), expiresAt: t.at(5 * MINUTE_MS) }, t.start + MINUTE_MS);
        t.harness.setNow(t.start + 4 * MINUTE_MS);
        expect(await store.consumeLastResortConfirmation(t.plan.id, 'a'.repeat(64), t.start + MINUTE_MS)).toMatchObject({ ok: false, error: { code: 'last_resort_token_invalid' } });
        t.harness.setNow(t.start + 4 * MINUTE_MS - 1);
        expect((await store.consumeLastResortConfirmation(t.plan.id, 'a'.repeat(64), t.start + MINUTE_MS)).ok).toBe(true);
      });
    });

    describe('playthroughs of a replayed scenario day (#234)', () => {
      // The daily anchor replays the same scenario day; a sandbox restart plays it again. Each playthrough starts at a
      // wall instant, and the store is scoped to it: its storm and its family messages are its own.
      const HOUR = 60 * MINUTE_MS;

      it('storm sessions and family messages belong to the playthrough they were written in', async () => {
        const t = setup();
        const first = t.harness.factory(t.homeA, { playthrough: t.start });
        const second = t.harness.factory(t.homeA, { playthrough: t.start + DAY_MS });
        await first.saveStormSession(t.storm(t.homeA, 'storm_firstplay01', 8 * HOUR, 'active'));
        await first.saveInboxMessage(message(t, 8 * HOUR, 'from the first playthrough'));
        t.harness.setNow(t.start + MINUTE_MS);
        // The replay is earlier on the scenario day than the first playthrough's storm: it still never sees it.
        expect(await second.getLatestStormSession()).toEqual({ ok: true, value: undefined });
        expect(await second.listInbox(10)).toEqual({ ok: true, value: [] });
        await second.saveStormSession(t.storm(t.homeA, 'storm_replayed001', 2 * HOUR));
        expect(await second.getLatestStormSession()).toMatchObject({ ok: true, value: { id: 'storm_replayed001' } });
        expect(await first.getLatestStormSession()).toMatchObject({ ok: true, value: { id: 'storm_firstplay01' } });
        expect(await first.listInbox(10)).toMatchObject({ ok: true, value: [{ text: 'from the first playthrough' }] });
      });

      it('the config-change and refusal logs span every playthrough, in the order they were written', async () => {
        const t = setup();
        const first = t.harness.factory(t.homeA, { playthrough: t.start });
        const second = t.harness.factory(t.homeA, { playthrough: t.start + DAY_MS });
        const late = t.change(8 * HOUR, 28);
        const early = t.change(2 * HOUR, 26);
        await first.putPreferences(t.prefs(), [late]);
        await first.recordGuardRejection({ at: t.at(8 * HOUR), failed: ['pacing_on_track'] });
        t.harness.setNow(t.start + MINUTE_MS);
        // Written later, at an earlier scenario hour of the replayed day.
        await second.putPreferences(t.prefs(), [early]);
        await second.recordGuardRejection({ at: t.at(2 * HOUR), failed: ['storm_reserve'] });
        for (const store of [first, second, t.harness.factory(t.homeA)]) {
          expect(await store.listConfigChanges()).toEqual({ ok: true, value: [late, early] });
          expect(await store.listGuardRejections()).toMatchObject({ ok: true, value: [{ failed: ['storm_reserve'] }, { failed: ['pacing_on_track'] }] });
        }
      });

      it('a store without a playthrough keeps today\'s keys: what it writes, it reads', async () => {
        const t = setup();
        const store = t.harness.factory(t.homeA);
        await store.saveStormSession(t.storm(t.homeA, 'storm_noplaythru', HOUR));
        expect(await t.harness.factory(t.homeA).getLatestStormSession()).toMatchObject({ ok: true, value: { id: 'storm_noplaythru' } });
        expect(await t.harness.factory(t.homeA, { playthrough: t.start }).getLatestStormSession()).toEqual({ ok: true, value: undefined });
      });
    });

    describe('sandbox settings (C1, approved in #214)', () => {
      const settings = (version: number, at: string): SandboxSettings =>
        SandboxSettingsSchema.parse({ version, updatedAt: at, scenarioId: 'heatwave', locationId: 'turin', units: 'C', household: 'older-woman' });

      it('answers settings_not_found before the first write, then the stored settings, from any store instance', async () => {
        const { harness, homeA, at } = setup();
        const store = harness.factory(homeA);
        expect(await store.getSandboxSettings()).toMatchObject({ ok: false, error: { code: 'settings_not_found', category: 'not_found' } });
        expect(await store.putSandboxSettings(settings(1, at(0)), undefined)).toEqual({ ok: true, value: undefined });
        expect(await harness.factory(homeA).getSandboxSettings()).toEqual({ ok: true, value: settings(1, at(0)) });
      });

      it('writes only against the version it read: a stale or repeated first write is settings_version_conflict, as a value', async () => {
        const { harness, homeA, at } = setup();
        const store = harness.factory(homeA);
        expect((await store.putSandboxSettings(settings(1, at(0)), undefined)).ok).toBe(true);
        expect((await store.putSandboxSettings(settings(2, at(1)), 1)).ok).toBe(true);
        expect(await store.putSandboxSettings({ ...settings(2, at(2)), units: 'F' }, 1)).toMatchObject({ ok: false, error: { code: 'settings_version_conflict', category: 'conflict' } });
        expect(await store.putSandboxSettings(settings(1, at(3)), undefined)).toMatchObject({ ok: false, error: { code: 'settings_version_conflict' } });
        expect(await store.getSandboxSettings()).toEqual({ ok: true, value: settings(2, at(1)) });
      });

      it('refuses settings whose version is not the one after the version read, and keeps homes apart', async () => {
        const { harness, homeA, homeB, at } = setup();
        const store = harness.factory(homeA);
        expect(await store.putSandboxSettings(settings(3, at(0)), undefined)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect((await store.putSandboxSettings(settings(1, at(0)), undefined)).ok).toBe(true);
        expect(await harness.factory(homeB).getSandboxSettings()).toMatchObject({ ok: false, error: { code: 'settings_not_found' } });
      });
    });

    describe.skipIf(makeHarness().sharedBackend === true)('admin config (C1, approved in #214)', () => {
      const admin = (version: number, at: string, sandboxDefaults: SandboxSettings): AdminSettings =>
        AdminSettingsSchema.parse({
          version,
          updatedAt: at,
          demoEnabled: true,
          caps: { turnsPerCodePerDay: 20, turnsGlobalPerDay: 30, toolCallsPerCodePerDay: 20, codeAttemptsPerIpPerHour: 10, sandboxesPerDay: 50, speechCharsPerCodePerDay: 6000, speechCharsGlobalPerDay: 30_000 },
          sandboxDefaults,
        });

      it('is one config for every home: written against the version read, a stale write is settings_version_conflict', async () => {
        const { harness, homeA, homeB, at } = setup();
        const defaults = SandboxSettingsSchema.parse({ version: 1, updatedAt: at(0), scenarioId: 'clear-day', locationId: 'reference', units: 'C', household: 'no-one-at-risk' });
        const store = harness.factory(homeA);
        // On a shared backend the config may already exist: write against what is there.
        const current = await store.getAdminConfig();
        const read = current.ok ? current.value.version : undefined;
        if (!current.ok) expect(current.error.code).toBe('settings_not_found');
        const next = admin((read ?? 0) + 1, at(0), defaults);
        expect(await store.putAdminConfig(next, read)).toEqual({ ok: true, value: undefined });
        expect(await harness.factory(homeB).getAdminConfig()).toEqual({ ok: true, value: next });
        expect(await store.putAdminConfig({ ...next, demoEnabled: false }, read)).toMatchObject({ ok: false, error: { code: 'settings_version_conflict' } });
      });
    });
  });
}
