import { HomeIdSchema, PreferencesSchema } from '@cold-reserve/contracts';
import { examplePreferences } from '@cold-reserve/contracts/fixtures';
import { fixedClock } from '@cold-reserve/core';
import { demoProfile } from '@cold-reserve/source-simulator';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { comfortPlanWiring, loadComfortPlanConfig } from '../src/comfort-plan-config.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../src/preferences-config.js';
import { TOKEN } from './helpers.js';

const clock = fixedClock(Date.parse('2026-09-30T10:00:00Z'));
const prefs = () => {
  const p = loadPreferencesConfig(preferencesConfigFile());
  if (!p.ok) throw new Error(p.error.message);
  return p.value;
};

describe('comfort-plan wiring', () => {
  it('loads the shipped configs (comfort plan and guard)', () => {
    const c = loadComfortPlanConfig();
    expect(c.ok && c.value.comfort.planTtlMinutes).toBe(10);
    expect(c.ok && c.value.guard.reserve.essentialLoadW).toBeGreaterThan(0);
  });

  it('uses the saved preferences, or the config defaults for the home', async () => {
    const backing = createMemoryBacking();
    const storeFor = memoryStateStoreFactory({ backing, clock });
    const wiring = comfortPlanWiring({ storeFor, preferences: prefs(), clock });
    if (!wiring.ok) throw new Error(wiring.error.message);
    const demo = HomeIdSchema.parse('demo');
    const defaults = await wiring.value.preferencesFor(demo, demoProfile());
    expect(defaults.ok && defaults.value.safeRoomId).toBe('bedroom-1');
    const saved = PreferencesSchema.parse({ ...examplePreferences(), comfortC: { cooling: 24, heating: 20 } });
    await storeFor(demo).putPreferences(saved, []);
    const read = await wiring.value.preferencesFor(demo, demoProfile());
    expect(read.ok && read.value.comfortC.cooling).toBe(24);
  });

  it('plan ids are fresh and valid', () => {
    const wiring = comfortPlanWiring({ storeFor: memoryStateStoreFactory({ backing: createMemoryBacking(), clock }), preferences: prefs(), clock });
    if (!wiring.ok) throw new Error(wiring.error.message);
    const a = wiring.value.newPlanId();
    expect(a).toMatch(/^plan_[A-Za-z0-9]{20}$/);
    expect(wiring.value.newPlanId()).not.toBe(a);
  });

  it('the app registers the module when it is wired, for the demo and the real home', () => {
    const wiring = comfortPlanWiring({ storeFor: memoryStateStoreFactory({ backing: createMemoryBacking(), clock }), preferences: prefs(), clock });
    if (!wiring.ok) throw new Error(wiring.error.message);
    const app = createApp({ MCP_CLIENTS: `agent@demo=${TOKEN}` }, { wallClock: clock, logger: { log: () => undefined }, comfortPlan: wiring.value });
    if (!app.ok) throw new Error(app.error.message);
    const names = (id: string) => app.value.registry.toolsFor(HomeIdSchema.parse(id)).map((t) => t.name);
    expect(names('demo')).toEqual(expect.arrayContaining(['plan_comfort', 'apply_plan', 'get_reserve_outlook']));
    expect(names('home')).toEqual(expect.arrayContaining(['plan_comfort']));
  });
});
