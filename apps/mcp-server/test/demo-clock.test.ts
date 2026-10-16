import { AdvanceClockOutputSchema, CARD_TOOL_ACCESS, GetMilestonesOutputSchema, HomeIdSchema, celsius, ok, pct, toolError, type HomeId, type Plan, type SandboxSettings } from '@cold-reserve/contracts';
import { examplePlan } from '@cold-reserve/contracts/fixtures';
import { localIso, memoryLogger, type StateStoreFactory } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { describe, expect, it } from 'vitest';
import type { DemoClockDeps } from '../src/modules/demo-clock.js';
import { demoSettingsModule } from '../src/modules/demo-settings.js';
import type { ToolDefinition } from '../src/tool.js';

// #311 (approved in #311): the judges' clock. A visitor lists the next moments of their own sandbox's day and jumps
// to one, or some hours ahead: never backwards, never past the scenario's end, the storm detector run on the way so
// the family hears what it would have heard in real time. Only visitor sandboxes; the real home and `demo` never.

const H = 3_600_000;
const TZ = 'Europe/Rome';
const WALL = Date.parse('2026-10-10T10:00:00Z');
const ANCHOR = Date.parse('2026-10-10T09:00:00Z');
const START = Date.parse('2026-07-17T00:00:00+02:00');
const END = START + 24 * H;
const A = HomeIdSchema.parse('demo#00000000000000aa');
const B = HomeIdSchema.parse('demo#00000000000000bb');
const ctx = (homeId: HomeId) => ({ correlationId: 'corr-clock', clientId: 'cards', homeId });
const iso = (ms: number) => localIso(ms, TZ);

/** The storm day: the grid down from 03:00 to 18:30. */
const OUTAGE = { fromMs: START + 3 * H, toMs: START + 18.5 * H };
const STABLE_MS = 10 * 60_000;

const planOf = (homeId: HomeId, over: Partial<Plan> = {}): Plan => {
  const step = (h: number, level: Plan['steps'][number]['level'], setpointC: number) => ({
    ts: iso(START + h * H),
    roomId: 'bedroom-1',
    hvacMode: 'cool' as const,
    setpointC: celsius(setpointC),
    fanOn: false,
    level,
    batteryTargetSocPct: pct(50),
  });
  return { ...(examplePlan() as Plan), homeId, steps: [step(1.5, 'comfort', 25), step(2, 'comfort', 24), step(5, 'essential', 24)], ...over };
};

function setup(over: Partial<DemoClockDeps> = {}) {
  const logger = memoryLogger();
  const storeFor = memoryStateStoreFactory({ backing: createMemoryBacking(), clock: { now: () => WALL } });
  // #406: the settings reads the module makes, counted on the store it is given.
  const reads = { settings: 0 };
  const counted: StateStoreFactory = (homeId, scope) =>
    new Proxy(storeFor(homeId, scope), {
      get(target, key) {
        if (key === 'getSandboxSettings') {
          return () => {
            reads.settings++;
            return target.getSandboxSettings();
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  // The sandbox as played here: its scenario time moves with the stored jump, as the real refresh plays it.
  const played = new Map<HomeId, number>();
  const versions = new Map<HomeId, number>();
  const stops: { atMs: number; kind: 'reading' | 'essential' }[] = [];
  const plans = new Map<string, Plan>([
    ['plan_own_00001', planOf(A, { id: 'plan_own_00001' as Plan['id'] })],
    ['plan_other_0001', planOf(B, { id: 'plan_other_0001' as Plan['id'] })],
  ]);
  const nowOf = (homeId: HomeId) => START + 1 * H + (played.get(homeId) ?? 0);
  const clock: DemoClockDeps = {
    day: (homeId) => ({ nowMs: nowOf(homeId), version: versions.get(homeId), anchorMs: ANCHOR, startMs: START, endMs: END, timeZone: TZ, outages: [OUTAGE], rechargeAtMs: START + 20 * H }),
    getPlan: (_homeId, planId) => {
      const plan = plans.get(planId);
      return Promise.resolve(plan === undefined ? { ok: false as const, error: toolError('plan_not_found', 'No such plan.') } : ok(plan));
    },
    detect: (c, kind) => {
      stops.push({ atMs: nowOf(c.homeId), kind });
      return Promise.resolve(ok(undefined));
    },
    stableGridMs: STABLE_MS,
    maxAdvancesPerDay: 30,
    ...over,
  };
  const module = demoSettingsModule({
    storeFor: counted,
    wallClock: { now: () => WALL },
    defaults: { scenarioId: 'storm-blackout', locationId: 'reference', units: 'C', household: 'older-man' },
    place: (id) => (id === 'reference' ? { id, label: 'Reference home', tz: TZ } : undefined),
    logger,
    onChange: (homeId, settings) => {
      played.set(homeId, settings.advancedMs ?? 0);
      versions.set(homeId, settings.version);
      return Promise.resolve();
    },
    clock,
  });
  const tool = (name: string) => module.tools.find((t) => t.name === name) as ToolDefinition;
  const settings = async () => {
    const r = await storeFor(A).getSandboxSettings();
    return r.ok ? r.value : undefined;
  };
  return { logger, stops, settings, storeFor, reads, list: tool('get_milestones'), advance: tool('advance_clock'), set: tool('set_scenario'), nowOf };
}

const summary = (t: ToolDefinition, value: unknown, homeId: HomeId = A) => t.summarize?.(t.output.parse(value), ctx(homeId)) ?? '';

describe('judges clock: who sees it (#311)', () => {
  it('both tools belong to the visitor sandbox module; the real home and demo are refused, nothing written', async () => {
    const { list, advance, storeFor } = setup();
    for (const home of ['home', 'demo']) {
      const id = HomeIdSchema.parse(home);
      expect(await list.handler({}, ctx(id))).toMatchObject({ ok: false, error: { code: 'home_not_allowed' } });
      expect(await advance.handler({ hours: 2 }, ctx(id))).toMatchObject({ ok: false, error: { code: 'home_not_allowed' } });
      expect(await storeFor(id).getSandboxSettings()).toMatchObject({ ok: false, error: { code: 'settings_not_found' } });
    }
  });

  it('marks the list read-only and the jump as a write that is not idempotent', () => {
    const { list, advance } = setup();
    expect(list.annotations).toMatchObject({ readOnlyHint: CARD_TOOL_ACCESS.get_milestones === 'read', destructiveHint: false, idempotentHint: true });
    expect(advance.annotations).toMatchObject({ readOnlyHint: CARD_TOOL_ACCESS.advance_clock === 'read', destructiveHint: false, idempotentHint: false });
  });
});

describe('get_milestones (#311)', () => {
  it("without a plan: the scenario's moments, the day (start and 24 h) and now, in home time", async () => {
    const { list } = setup();
    const r = await list.handler({}, ctx(A));
    if (!r.ok) throw new Error(r.error.message);
    const out = GetMilestonesOutputSchema.parse(r.value);
    expect(out.now).toBe('2026-07-17T01:00:00+02:00');
    expect(out.day).toEqual({ from: '2026-07-17T00:00:00+02:00', to: '2026-07-18T00:00:00+02:00' });
    expect(out.milestones.map((m) => [m.kind, m.at])).toEqual([
      ['storm_start', '2026-07-17T03:00:00+02:00'],
      ['power_back', '2026-07-17T18:40:00+02:00'],
      ['next_recharge', '2026-07-17T20:00:00+02:00'],
    ]);
    // The summary carries every time the assistant may say.
    const text = summary(list, r.value);
    for (const m of out.milestones) expect(text).toContain(m.at);
    expect(text).toContain(out.now);
  });

  it("with the sandbox's own plan: its moments too, from its own fields", async () => {
    const { list } = setup();
    const r = await list.handler({ planId: 'plan_own_00001' }, ctx(A));
    if (!r.ok) throw new Error(r.error.message);
    expect(GetMilestonesOutputSchema.parse(r.value).milestones.map((m) => m.kind)).toEqual(['pre_cooling_start', 'storm_start', 'essential_level', 'power_back', 'next_recharge']);
  });

  it("another sandbox's plan is plan_not_found, with none of its data", async () => {
    const { list } = setup();
    const r = await list.handler({ planId: 'plan_other_0001' }, ctx(A));
    expect(r).toMatchObject({ ok: false, error: { code: 'plan_not_found' } });
    expect(JSON.stringify(r)).not.toContain(B);
    expect(JSON.stringify(r)).not.toContain('essential');
  });

  it('a store failure on the plan comes back as a value', async () => {
    const { list } = setup({ getPlan: () => Promise.resolve({ ok: false as const, error: toolError('store_unavailable', 'Down.') }) });
    expect(await list.handler({ planId: 'plan_own_00001' }, ctx(A))).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
  });
});

describe('advance_clock (#311)', () => {
  it('jumps to a listed milestone: the stored jump, a new settings version, the detector run there', async () => {
    const { advance, settings, stops, nowOf } = setup();
    const r = await advance.handler({ kind: 'storm_start', at: '2026-07-17T03:00:00+02:00' }, ctx(A));
    if (!r.ok) throw new Error(r.error.message);
    expect(AdvanceClockOutputSchema.parse(r.value)).toEqual({ now: '2026-07-17T03:00:00+02:00', settingsVersion: (await settings())?.version });
    expect(nowOf(A)).toBe(OUTAGE.fromMs);
    expect((await settings())?.advancedMs).toBe(2 * H);
    expect(stops).toEqual([{ atMs: OUTAGE.fromMs, kind: 'reading' }]);
    expect(summary(advance, r.value)).toContain('2026-07-17T03:00:00+02:00');
  });

  it('pins the playthrough it jumps in: the same anchor, so the storm sessions and the inbox stay', async () => {
    const { advance, settings } = setup();
    await advance.handler({ hours: 1 }, ctx(A));
    expect((await settings())?.scenarioStartedAt).toBe(new Date(ANCHOR).toISOString());
  });

  it('runs the detector at every storm start and power back it crosses, after the stable grid, and at the target', async () => {
    const { advance, stops } = setup();
    expect(await advance.handler({ hours: 20 }, ctx(A))).toMatchObject({ ok: true });
    expect(stops).toEqual([
      { atMs: OUTAGE.fromMs, kind: 'reading' },
      { atMs: OUTAGE.toMs, kind: 'reading' },
      { atMs: OUTAGE.toMs + STABLE_MS, kind: 'reading' },
      { atMs: START + 21 * H, kind: 'reading' },
    ]);
  });

  it('a jump to power back lands when the grid has been stable: the grid comes back on the way, the target ends the storm', async () => {
    const { advance, stops } = setup();
    const r = await advance.handler({ kind: 'power_back', at: '2026-07-17T18:40:00+02:00' }, ctx(A));
    expect(r).toMatchObject({ ok: true, value: { now: '2026-07-17T18:40:00+02:00' } });
    expect(stops).toEqual([
      { atMs: OUTAGE.fromMs, kind: 'reading' },
      { atMs: OUTAGE.toMs, kind: 'reading' },
      { atMs: OUTAGE.toMs + STABLE_MS, kind: 'reading' },
    ]);
  });

  it("with the sandbox's plan, crosses its first essential step once, with the essential reading", async () => {
    const { advance, stops } = setup();
    await advance.handler({ hours: 6, planId: 'plan_own_00001' }, ctx(A));
    expect(stops).toEqual([
      { atMs: OUTAGE.fromMs, kind: 'reading' },
      { atMs: START + 5 * H, kind: 'essential' },
      { atMs: START + 7 * H, kind: 'essential' },
    ]);
  });

  it('a plan essential from its first step (made in the storm, often now): every stop is an essential reading, told once by the detector', async () => {
    const { advance, stops } = setup({
      getPlan: () => Promise.resolve(ok({ ...planOf(A), steps: planOf(A).steps.map((s) => ({ ...s, ts: iso(START), level: 'essential' as const })) })),
    });
    await advance.handler({ hours: 3, planId: 'plan_own_00001' }, ctx(A));
    expect(stops).toEqual([
      { atMs: OUTAGE.fromMs, kind: 'essential' },
      { atMs: START + 4 * H, kind: 'essential' },
    ]);
  });

  it("refuses a plan milestone without the plan, another sandbox's plan, an unlisted or past moment, past the end: nothing written", async () => {
    const { advance, settings, stops } = setup();
    expect(await advance.handler({ kind: 'essential_level', at: iso(START + 5 * H) }, ctx(A))).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await advance.handler({ kind: 'essential_level', at: iso(START + 5 * H), planId: 'plan_other_0001' }, ctx(A))).toMatchObject({ ok: false, error: { code: 'plan_not_found' } });
    expect(await advance.handler({ kind: 'storm_start', at: iso(START + 4 * H) }, ctx(A))).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await advance.handler({ kind: 'storm_start', at: iso(START) }, ctx(A))).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await advance.handler({ hours: 24 }, ctx(A))).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await settings()).toBeUndefined();
    expect(stops).toEqual([]);
  });

  it('a double tap: two jumps at once, one wins, the other is a conflict; the detector runs once', async () => {
    const { advance, stops, nowOf } = setup();
    const storm = { kind: 'storm_start', at: '2026-07-17T03:00:00+02:00' };
    const results = await Promise.all([advance.handler(storm, ctx(A)), advance.handler(storm, ctx(A))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([{ error: { code: 'settings_version_conflict' } }]);
    expect(nowOf(A)).toBe(OUTAGE.fromMs);
    expect(stops).toEqual([{ atMs: OUTAGE.fromMs, kind: 'reading' }]);
  });

  it('a jump planned on settings another container has moved since is a conflict: nothing moves here', async () => {
    const { advance, storeFor, stops, nowOf } = setup();
    // Another container jumped 5 hours; this one has not replayed it yet.
    const saved = await storeFor(A).putSandboxSettings(
      { version: 1, updatedAt: new Date(WALL).toISOString(), scenarioId: 'storm-blackout', locationId: 'reference', units: 'C', household: 'older-man', advancedMs: 5 * H },
      undefined,
    );
    expect(saved.ok).toBe(true);
    expect(await advance.handler({ hours: 1 }, ctx(A))).toMatchObject({ ok: false, error: { code: 'settings_version_conflict' } });
    expect(nowOf(A)).toBe(START + H);
    expect(stops).toEqual([]);
  });

  it('never lists a moment past the end of the scenario', async () => {
    const late = { fromMs: START + 23 * H, toMs: START + 30 * H };
    const { list } = setup({ day: () => ({ nowMs: START + 10 * H, version: undefined, anchorMs: ANCHOR, startMs: START, endMs: END, timeZone: TZ, outages: [late] }) });
    const r = await list.handler({}, ctx(A));
    expect(r.ok && GetMilestonesOutputSchema.parse(r.value).milestones.map((m) => m.kind)).toEqual(['storm_start']);
  });

  it('the same milestone twice: the second time it is behind now and refused', async () => {
    const { advance } = setup();
    const storm = { kind: 'storm_start', at: '2026-07-17T03:00:00+02:00' };
    expect(await advance.handler(storm, ctx(A))).toMatchObject({ ok: true });
    expect(await advance.handler(storm, ctx(A))).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('a restart is the only way back: it sets the jump to zero', async () => {
    const { advance, set, settings } = setup();
    await advance.handler({ hours: 3 }, ctx(A));
    expect((await settings())?.advancedMs).toBe(3 * H);
    expect(await set.handler({ restart: true }, ctx(A))).toMatchObject({ ok: true });
    const after = (await settings()) as SandboxSettings;
    expect(after.advancedMs ?? 0).toBe(0);
  });

  it('logs one line per jump: correlation id, home said as sandbox, from, to, kind; never the sandbox id', async () => {
    const { advance, logger } = setup();
    await advance.handler({ hours: 20 }, ctx(A));
    const lines = logger.lines.filter((l) => l.details?.['event'] === 'clock_advanced');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', correlationId: 'corr-clock', details: { home: 'sandbox', from: '2026-07-17T01:00:00+02:00', to: '2026-07-17T21:00:00+02:00', kind: 'hours' } });
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  });

  it('allows 30 jumps per sandbox per day; the next is refused as a quota, another sandbox still may', async () => {
    const { advance } = setup({ maxAdvancesPerDay: 2 });
    expect(await advance.handler({ hours: 1 }, ctx(A))).toMatchObject({ ok: true });
    expect(await advance.handler({ hours: 1 }, ctx(A))).toMatchObject({ ok: true });
    expect(await advance.handler({ hours: 1 }, ctx(A))).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded' } });
    expect(await advance.handler({ hours: 1 }, ctx(B))).toMatchObject({ ok: true });
  });

  it('reads the settings once per jump, however many stops it makes on the way (#406)', async () => {
    const { advance, reads, stops } = setup();
    expect(await advance.handler({ hours: 20 }, ctx(A))).toMatchObject({ ok: true });
    expect(stops).toHaveLength(4);
    expect(reads.settings).toBe(1);
    expect(await advance.handler({ hours: 1 }, ctx(A))).toMatchObject({ ok: true });
    expect(reads.settings).toBe(2);
  });

  it('settings another container moves in the middle of a jump: the next stop is a conflict, the jump stays where it stopped (#406)', async () => {
    let otherContainer: (() => Promise<void>) | undefined;
    const { advance, storeFor, logger, nowOf } = setup({
      detect: async () => {
        await otherContainer?.();
        otherContainer = undefined;
        return ok(undefined);
      },
    });
    otherContainer = async () => {
      const stored = await storeFor(A).getSandboxSettings();
      if (!stored.ok) throw new Error(stored.error.message);
      const saved = await storeFor(A).putSandboxSettings({ ...stored.value, version: stored.value.version + 1, advancedMs: 5 * H }, stored.value.version);
      if (!saved.ok) throw new Error(saved.error.message);
    };
    const r = await advance.handler({ hours: 20 }, ctx(A));
    expect(r).toMatchObject({ ok: false, error: { code: 'settings_version_conflict', message: 'The day moved on meanwhile: ask get_milestones again.' } });
    expect(nowOf(A)).toBe(OUTAGE.fromMs);
    expect(logger.lines.find((l) => l.details?.['event'] === 'clock_advance_failed')).toMatchObject({ level: 'warn', code: 'settings_version_conflict', correlationId: 'corr-clock' });
  });

  it('a detector failure stops the jump where it is, comes back as a value and is logged', async () => {
    const { advance, logger, nowOf } = setup({ detect: () => Promise.resolve({ ok: false as const, error: toolError('store_unavailable', 'Down.') }) });
    expect(await advance.handler({ hours: 20 }, ctx(A))).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
    expect(nowOf(A)).toBe(OUTAGE.fromMs);
    expect(logger.lines.find((l) => l.code === 'store_unavailable')).toMatchObject({ level: 'error', correlationId: 'corr-clock', details: { event: 'clock_advance_failed', home: 'sandbox' } });
  });
});
