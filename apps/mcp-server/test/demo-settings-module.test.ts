import { CARD_TOOL_ACCESS, HomeIdSchema, SandboxSettingsSchema, SetScenarioOutputSchema, toolError, type HomeId, type SandboxSettings } from '@cold-reserve/contracts';
import { memoryLogger, type StateStore } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { describe, expect, it } from 'vitest';
import { demoSettingsModule, type DemoSettingsDeps } from '../src/modules/demo-settings.js';
import type { ToolDefinition } from '../src/tool.js';

// C2b (#222, contracts approved in #222): a visitor changes their own sandbox. Only sandboxes list the tools; the real
// home and `demo` never reach them (a second check in the handler). Every change is logged, never with the home id.

const WALL = Date.parse('2026-10-04T10:00:00Z');
const A = HomeIdSchema.parse('demo#00000000000000aa');
const B = HomeIdSchema.parse('demo#00000000000000bb');
const ctx = (homeId: HomeId) => ({ correlationId: 'corr-1', clientId: 'agent', homeId });

function setup(over: Partial<DemoSettingsDeps> = {}) {
  const logger = memoryLogger();
  const changed: { homeId: HomeId; settings: SandboxSettings }[] = [];
  const deps: DemoSettingsDeps = {
    storeFor: memoryStateStoreFactory({ backing: createMemoryBacking(), clock: { now: () => WALL } }),
    wallClock: { now: () => WALL },
    defaults: { scenarioId: 'clear-day', locationId: 'reference', units: 'C', household: 'older-man' },
    place: (id) => (id === 'reference' ? { id, label: 'Reference home', tz: 'Europe/Rome' } : undefined),
    logger,
    onChange: (homeId, settings) => {
      changed.push({ homeId, settings });
      return Promise.resolve();
    },
    ...over,
  };
  const module = demoSettingsModule(deps);
  const tool = (name: string) => module.tools.find((t) => t.name === name) as ToolDefinition;
  return { deps, logger, changed, module, get: tool('get_demo_settings'), set: tool('set_scenario') };
}

describe('demo settings module: who sees it', () => {
  it('is listed for visitor sandboxes only, never for the real home or the shared demo', () => {
    const { module } = setup();
    expect(module.enabledFor?.(A)).toBe(true);
    expect(module.enabledFor?.(HomeIdSchema.parse('home'))).toBe(false);
    expect(module.enabledFor?.(HomeIdSchema.parse('demo'))).toBe(false);
  });

  it('refuses a call on the real home or on demo even if it gets there: home_not_allowed, nothing written', async () => {
    const { get, set, deps } = setup();
    for (const home of ['home', 'demo']) {
      const id = HomeIdSchema.parse(home);
      expect(await get.handler({}, ctx(id))).toMatchObject({ ok: false, error: { code: 'home_not_allowed' } });
      expect(await set.handler({ scenarioId: 'heatwave' }, ctx(id))).toMatchObject({ ok: false, error: { code: 'home_not_allowed' } });
      expect(await deps.storeFor(id).getSandboxSettings()).toMatchObject({ ok: false, error: { code: 'settings_not_found' } });
    }
  });

  it('marks get as read-only, set as idempotent and not destructive', () => {
    const { get, set } = setup();
    expect(get.annotations).toMatchObject({ readOnlyHint: CARD_TOOL_ACCESS.get_demo_settings === 'read', destructiveHint: false, idempotentHint: true });
    expect(set.annotations).toMatchObject({ readOnlyHint: CARD_TOOL_ACCESS.set_scenario === 'read', destructiveHint: false, idempotentHint: true });
  });
});

describe('get_demo_settings', () => {
  it('gives the defaults before anything is saved, with the place, and says every value', async () => {
    const { get } = setup();
    const r = await get.handler({}, ctx(A));
    expect(r).toMatchObject({ ok: true, value: { settings: { scenarioId: 'clear-day', locationId: 'reference', units: 'C', household: 'older-man' }, place: { tz: 'Europe/Rome' } } });
    const summary = r.ok ? (get.summarize?.(get.output.parse(r.value), ctx(A)) ?? '') : '';
    expect(summary).toMatch(/clear-day/);
    expect(summary).toMatch(/Reference home/);
    expect(summary).toMatch(/°C/);
  });

  it('returns a store failure as a value', async () => {
    const failing = (home: HomeId) => ({ ...memoryStateStoreFactory({ backing: createMemoryBacking(), clock: { now: () => WALL } })(home), getSandboxSettings: () => Promise.resolve({ ok: false as const, error: toolError('store_unavailable', 'Down.') }) }) as StateStore;
    const { get } = setup({ storeFor: failing });
    expect(await get.handler({}, ctx(A))).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
  });
});

describe('set_scenario', () => {
  it('saves the first change as version 1 from the defaults, plays it here at once, and logs each changed field', async () => {
    const { set, deps, changed, logger } = setup();
    const r = await set.handler({ scenarioId: 'storm-blackout', household: 'older-woman', units: 'F' }, ctx(A));
    expect(r).toMatchObject({ ok: true, value: { settings: { version: 1, scenarioId: 'storm-blackout', household: 'older-woman', units: 'F', locationId: 'reference' }, restarted: true } });
    expect(await deps.storeFor(A).getSandboxSettings()).toMatchObject({ ok: true, value: { version: 1, scenarioId: 'storm-blackout' } });
    expect(changed).toEqual([{ homeId: A, settings: expect.objectContaining({ version: 1 }) as SandboxSettings }]);
    const lines = logger.lines.filter((l) => l.details?.['event'] === 'config_change');
    expect(lines.map((l) => l.details?.['field']).sort()).toEqual(['household', 'scenarioId', 'units']);
    expect(lines[0]).toMatchObject({ level: 'info', correlationId: 'corr-1', details: { area: 'sandbox', by: 'visitor', home: 'sandbox' } });
    expect(lines.find((l) => l.details?.['field'] === 'units')?.details).toMatchObject({ from: 'C', to: 'F' });
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  });

  it('writes against the version it read: the next change is version 2; a units change alone does not restart the day', async () => {
    let wall = WALL;
    const { set } = setup({ wallClock: { now: () => wall } });
    const first = await set.handler({ scenarioId: 'heatwave' }, ctx(A));
    wall += 60_000;
    const r = await set.handler({ units: 'F' }, ctx(A));
    expect(r).toMatchObject({ ok: true, value: { settings: { version: 2, scenarioId: 'heatwave', units: 'F' }, restarted: false } });
    // The day keeps its start: only the units changed.
    const settingsOf = (x: typeof r) => (x.ok ? SetScenarioOutputSchema.parse(x.value).settings : undefined);
    expect(settingsOf(r)?.scenarioStartedAt).toBe(settingsOf(first)?.scenarioStartedAt);
    expect(settingsOf(r)?.updatedAt).toBe(new Date(WALL + 60_000).toISOString());
  });

  it('restarts the day on request, and on a new scenario or place', async () => {
    const { set } = setup();
    await set.handler({ units: 'F' }, ctx(A));
    expect(await set.handler({ restart: true }, ctx(A))).toMatchObject({ ok: true, value: { restarted: true, settings: { scenarioStartedAt: new Date(WALL).toISOString() } } });
    expect(await set.handler({ scenarioId: 'heatwave' }, ctx(A))).toMatchObject({ ok: true, value: { restarted: true } });
  });

  it('a change to the same values writes nothing new and logs nothing', async () => {
    const { set, logger, changed } = setup();
    await set.handler({ scenarioId: 'heatwave' }, ctx(A));
    const lines = logger.lines.length;
    expect(await set.handler({ scenarioId: 'heatwave' }, ctx(A))).toMatchObject({ ok: true, value: { settings: { version: 1 }, restarted: false } });
    expect(logger.lines.length).toBe(lines);
    expect(changed).toHaveLength(1);
  });

  it('never writes one sandbox from another', async () => {
    const { set, deps } = setup();
    await set.handler({ scenarioId: 'heatwave' }, ctx(A));
    expect(await deps.storeFor(B).getSandboxSettings()).toMatchObject({ ok: false, error: { code: 'settings_not_found' } });
  });

  it('refuses a place that is not available yet, writing nothing', async () => {
    const { set, deps } = setup();
    expect(await set.handler({ locationId: 'houston' }, ctx(A))).toMatchObject({ ok: false, error: { code: 'invalid_input', details: { field: 'locationId' } } });
    expect(await deps.storeFor(A).getSandboxSettings()).toMatchObject({ ok: false, error: { code: 'settings_not_found' } });
  });

  it('°F everywhere (owner decision, 9 Oct): a new place starts in its own unit; a unit sent with it, or later, wins', async () => {
    const everywhere = (id: string) => ({ id, label: id, tz: id === 'houston' ? 'America/Chicago' : 'Europe/Rome' });
    const { set } = setup({ place: (id) => everywhere(id) as ReturnType<DemoSettingsDeps['place']> });
    expect(await set.handler({ locationId: 'houston' }, ctx(A))).toMatchObject({ ok: true, value: { settings: { locationId: 'houston', units: 'F' } } });
    expect(await set.handler({ units: 'C' }, ctx(A))).toMatchObject({ ok: true, value: { settings: { locationId: 'houston', units: 'C' } } });
    expect(await set.handler({ scenarioId: 'storm-blackout' }, ctx(A))).toMatchObject({ ok: true, value: { settings: { units: 'C' } } });
    expect(await set.handler({ locationId: 'turin' }, ctx(A))).toMatchObject({ ok: true, value: { settings: { locationId: 'turin', units: 'C' } } });
    expect(await set.handler({ locationId: 'houston', units: 'C' }, ctx(A))).toMatchObject({ ok: true, value: { settings: { locationId: 'houston', units: 'C' } } });
  });

  it('returns a conflicting write as settings_version_conflict and a store failure as a value', async () => {
    const backing = createMemoryBacking();
    const base = memoryStateStoreFactory({ backing, clock: { now: () => WALL } });
    const conflict = (home: HomeId) => ({ ...base(home), getSandboxSettings: base(home).getSandboxSettings.bind(base(home)), putSandboxSettings: () => Promise.resolve({ ok: false as const, error: toolError('settings_version_conflict', 'Changed.') }) }) as StateStore;
    expect(await setup({ storeFor: conflict }).set.handler({ scenarioId: 'heatwave' }, ctx(A))).toMatchObject({ ok: false, error: { code: 'settings_version_conflict' } });
    const down = (home: HomeId) => ({ ...base(home), getSandboxSettings: () => Promise.resolve({ ok: false as const, error: toolError('store_unavailable', 'Down.') }) }) as StateStore;
    const { set, changed } = setup({ storeFor: down });
    expect(await set.handler({ scenarioId: 'heatwave' }, ctx(A))).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
    expect(changed).toHaveLength(0);
  });

  it('says every value in its summary, in the units chosen', async () => {
    const { set } = setup();
    const r = await set.handler({ scenarioId: 'heatwave', units: 'F' }, ctx(A));
    const summary = r.ok ? (set.summarize?.(set.output.parse(r.value), ctx(A)) ?? '') : '';
    expect(summary).toMatch(/heatwave/);
    expect(summary).toMatch(/°F/);
    expect(summary).toMatch(/version 1/);
    expect(summary).toMatch(/starts again/);
  });

  it('stored settings stay valid against the contract', async () => {
    const { set, deps } = setup();
    await set.handler({ household: 'no-one-at-risk' }, ctx(A));
    const stored = await deps.storeFor(A).getSandboxSettings();
    expect(stored.ok && SandboxSettingsSchema.safeParse(stored.value).success).toBe(true);
  });
});
