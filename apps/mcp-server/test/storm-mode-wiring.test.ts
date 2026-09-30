import { HomeIdSchema } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../src/preferences-config.js';
import { stormModeWiring } from '../src/storm-mode-config.js';
import { TOKEN } from './helpers.js';

const clock = fixedClock(Date.parse('2026-09-30T10:00:00Z'));

function wiring() {
  const p = loadPreferencesConfig(preferencesConfigFile());
  if (!p.ok) throw new Error(p.error.message);
  const w = stormModeWiring({ storeFor: memoryStateStoreFactory({ backing: createMemoryBacking(), clock }), preferences: p.value, clock });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

describe('storm-mode wiring', () => {
  it('loads the shipped config and starts with an empty phone', () => {
    const w = wiring();
    expect(w.config.capHours).toBe(24);
    expect(w.inbox(HomeIdSchema.parse('demo'))).toEqual([]);
  });

  it('storm ids are fresh and valid', () => {
    const w = wiring();
    const a = w.newStormId();
    expect(a).toMatch(/^storm_[A-Za-z0-9]{20}$/);
    expect(w.newStormId()).not.toBe(a);
  });

  it('the app registers the three tools when the module is wired, and none without it', () => {
    const names = (stormMode?: ReturnType<typeof wiring>) => {
      const app = createApp({ MCP_CLIENTS: `agent@demo=${TOKEN}` }, { wallClock: clock, logger: { log: () => undefined }, ...(stormMode ? { stormMode } : {}) });
      if (!app.ok) throw new Error(app.error.message);
      return app.value.registry.toolsFor(HomeIdSchema.parse('demo')).map((t) => t.name);
    };
    expect(names(wiring())).toEqual(expect.arrayContaining(['start_storm_mode', 'get_safe_room_status', 'notify_family']));
    expect(names()).not.toContain('notify_family');
  });
});
