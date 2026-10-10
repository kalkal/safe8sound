import { HomeIdSchema, SandboxSettingsSchema, err, ok, toolError } from '@cold-reserve/contracts';
import { memoryLogger, type StateStore, type StateStoreFactory } from '@cold-reserve/core';
import { builtInScenario } from '@cold-reserve/source-simulator';
import { describe, expect, it } from 'vitest';
import { refreshFrom, safeRoomRole, withHousehold, type SandboxPlay } from '../src/sandbox-play.js';

// C2b (#222, decided by the owner on 3/10): who is at home decides the role in the safe room. Grandpa and grandma are
// at risk (same limits and windows); with no one at risk the occupant is an adult. Health thresholds are not settings.

const rolesOf = (s: ReturnType<typeof builtInScenario>) => s.occupancy.flatMap((o) => o.roles);

describe('withHousehold', () => {
  it('keeps grandpa for an older man: the scenario is unchanged', () => {
    const storm = builtInScenario('storm-blackout');
    expect(withHousehold(storm, 'older-man')).toEqual(storm);
    expect(safeRoomRole('older-man')).toBe('grandpa');
  });

  it('puts grandma in the safe room for an older woman, and an adult when no one is at risk; the others stay', () => {
    for (const id of ['clear-day', 'heatwave', 'storm-blackout'] as const) {
      const scenario = builtInScenario(id);
      const daughters = rolesOf(scenario).filter((r) => r === 'daughter').length;
      for (const [household, role] of [['older-woman', 'grandma'], ['no-one-at-risk', 'adult']] as const) {
        const played = withHousehold(scenario, household);
        expect(rolesOf(played)).not.toContain('grandpa');
        expect(rolesOf(played)).toContain(role);
        expect(rolesOf(played).filter((r) => r === 'daughter')).toHaveLength(daughters);
        expect(played.occupancy.map((o) => [o.roomId, o.fromH, o.toH])).toEqual(scenario.occupancy.map((o) => [o.roomId, o.fromH, o.toH]));
      }
    }
  });

  it('never changes the scenario it was given', () => {
    const storm = builtInScenario('storm-blackout');
    const before = structuredClone(storm);
    withHousehold(storm, 'older-woman');
    expect(storm).toEqual(before);
  });
});

describe('refreshFrom: one settings read per request (C2b)', () => {
  const A = HomeIdSchema.parse('demo#00000000000000aa');
  const settings = SandboxSettingsSchema.parse({ version: 2, updatedAt: '2026-10-04T10:00:00Z', scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' });
  const play = (version?: number): SandboxPlay => ({ entry: {} as SandboxPlay['entry'], forecast: () => ({}) as ReturnType<SandboxPlay['forecast']>, units: 'C', scenario: {} as SandboxPlay['scenario'], startMs: 0, ...(version === undefined ? {} : { version }) });
  const storeWith = (read: Awaited<ReturnType<StateStore['getSandboxSettings']>>): StateStoreFactory => () => ({ getSandboxSettings: () => Promise.resolve(read) }) as unknown as StateStore;

  it('keeps the sandbox when the version is the one played, and rebuilds it on a new one', async () => {
    const logger = memoryLogger();
    const rebuilt = play(2);
    const refresh = refreshFrom(storeWith(ok(settings)), () => ok(rebuilt), logger);
    const same = play(2);
    expect(await refresh(A, same, 'c')).toBe(same);
    expect(await refresh(A, play(1), 'c')).toBe(rebuilt);
  });

  it('warns once per build when no settings are saved, and keeps the defaults', async () => {
    const logger = memoryLogger();
    const refresh = refreshFrom(storeWith(err(toolError('settings_not_found', 'None.'))), () => ok(play(9)), logger);
    const defaults = play();
    expect(await refresh(A, defaults, 'c')).toBe(defaults);
    expect(await refresh(A, defaults, 'c')).toBe(defaults);
    expect(logger.lines.filter((l) => l.details?.['event'] === 'settings_missing')).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: 'warn', code: 'settings_not_found', details: { home: 'sandbox' } });
  });

  it('keeps playing when the store fails or the settings cannot be played, and logs each with its code', async () => {
    const logger = memoryLogger();
    const current = play(1);
    expect(await refreshFrom(storeWith(err(toolError('store_unavailable', 'Down.'))), () => ok(play(2)), logger)(A, current, 'c')).toBe(current);
    expect(await refreshFrom(storeWith(ok(settings)), () => err(toolError('invalid_config', 'No place.')), logger)(A, current, 'c')).toBe(current);
    expect(logger.lines.map((l) => [l.level, l.code, l.details?.['event']])).toEqual([
      ['warn', 'store_unavailable', 'settings_read_failed'],
      ['error', 'invalid_config', 'settings_play_failed'],
    ]);
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  });
});
