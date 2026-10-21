import { HomeIdSchema, SandboxSettingsSchema, err, ok, toolError, type SandboxSettings } from '@cold-reserve/contracts';
import { fixedClock, memoryLogger, type StateStore, type StateStoreFactory } from '@cold-reserve/core';
import { builtInScenario } from '@cold-reserve/source-simulator';
import { describe, expect, it } from 'vitest';
import { refreshFrom, safeRoomRole, withHousehold, type SandboxPlay } from '../src/sandbox-play.js';

// C2b (#222, decided by the owner on 3/10): who is at home decides the role in the safe room. Grandpa and grandma are
// at risk (same limits and windows); with no one at risk the occupant is an adult. Health thresholds are not settings.
// Since 20 Oct only an older man or no one at risk is offered; a saved 'older-woman' plays as the older man.

const rolesOf = (s: ReturnType<typeof builtInScenario>) => s.occupancy.flatMap((o) => o.roles);

describe('withHousehold', () => {
  it('keeps grandpa for an older man: the scenario is unchanged', () => {
    const storm = builtInScenario('storm-blackout');
    expect(withHousehold(storm, 'older-man')).toEqual(storm);
    expect(safeRoomRole('older-man')).toBe('grandpa');
  });

  it('plays a saved "older-woman" ("A frail person", no longer offered, 20 Oct) as the older man: grandpa', () => {
    const storm = builtInScenario('storm-blackout');
    expect(withHousehold(storm, 'older-woman')).toEqual(storm);
    expect(safeRoomRole('older-woman')).toBe('grandpa');
  });

  it('puts an adult in the safe room when no one is at risk; the others stay', () => {
    for (const id of ['clear-day', 'heatwave', 'storm-blackout'] as const) {
      const scenario = builtInScenario(id);
      const daughters = rolesOf(scenario).filter((r) => r === 'daughter').length;
      for (const [household, role] of [['no-one-at-risk', 'adult']] as const) {
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
    withHousehold(storm, 'no-one-at-risk');
    expect(storm).toEqual(before);
  });
});

describe('refreshFrom: one settings read per request (C2b)', () => {
  const A = HomeIdSchema.parse('demo#00000000000000aa');
  const settings = SandboxSettingsSchema.parse({ version: 2, updatedAt: '2026-10-04T10:00:00Z', scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' });
  const play = (version?: number): SandboxPlay => ({ entry: {} as SandboxPlay['entry'], forecast: () => ({}) as ReturnType<SandboxPlay['forecast']>, units: 'C', household: 'older-man', place: 'reference', scenario: {} as SandboxPlay['scenario'], startMs: 0, ...(version === undefined ? {} : { version }) });
  const storeWith = (read: Awaited<ReturnType<StateStore['getSandboxSettings']>>): StateStoreFactory => () => ({ getSandboxSettings: () => Promise.resolve(read) }) as unknown as StateStore;
  const clock = fixedClock(Date.parse('2026-10-19T07:00:00Z'));

  it('keeps the sandbox when the version is the one played, and rebuilds it on a new one', async () => {
    const logger = memoryLogger();
    const rebuilt = play(2);
    const refresh = refreshFrom(storeWith(ok(settings)), () => ok(rebuilt), logger, clock);
    const same = play(2);
    expect(await refresh(A, same, 'c')).toBe(same);
    expect(await refresh(A, play(1), 'c')).toBe(rebuilt);
  });

  it('plays the settings this request has just saved without reading them again (#406)', async () => {
    const logger = memoryLogger();
    let reads = 0;
    const counting: StateStoreFactory = () =>
      ({
        getSandboxSettings: () => {
          reads++;
          return Promise.resolve(ok(settings));
        },
      }) as unknown as StateStore;
    const rebuilt = play(2);
    const refresh = refreshFrom(counting, () => ok(rebuilt), logger, clock);
    expect(await refresh(A, play(1), 'c', settings)).toBe(rebuilt);
    const same = play(2);
    expect(await refresh(A, same, 'c', settings)).toBe(same);
    expect(reads).toBe(0);
    expect(logger.lines).toEqual([]);
  });

  it('warns once per build when no settings are saved, and keeps the defaults', async () => {
    const logger = memoryLogger();
    const refresh = refreshFrom(storeWith(err(toolError('settings_not_found', 'None.'))), () => ok(play(9)), logger, clock);
    const defaults = play();
    expect(await refresh(A, defaults, 'c')).toBe(defaults);
    expect(await refresh(A, defaults, 'c')).toBe(defaults);
    expect(logger.lines.filter((l) => l.details?.['event'] === 'settings_missing')).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: 'warn', code: 'settings_not_found', details: { home: 'sandbox' } });
  });

  it('keeps playing when the store fails or the settings cannot be played, and logs each with its code', async () => {
    const logger = memoryLogger();
    const current = play(1);
    expect(await refreshFrom(storeWith(err(toolError('store_unavailable', 'Down.'))), () => ok(play(2)), logger, clock)(A, current, 'c')).toBe(current);
    expect(await refreshFrom(storeWith(ok(settings)), () => err(toolError('invalid_config', 'No place.')), logger, clock)(A, current, 'c')).toBe(current);
    expect(logger.lines.map((l) => [l.level, l.code, l.details?.['event']])).toEqual([
      ['warn', 'store_unavailable', 'settings_read_failed'],
      ['error', 'invalid_config', 'settings_play_failed'],
    ]);
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  });
});

describe('refreshFrom: a new sandbox stores its start at its first request (#449)', () => {
  const A = HomeIdSchema.parse('demo#00000000000000aa');
  const clock = fixedClock(Date.parse('2026-10-19T07:00:00Z'));
  const firstStart = { scenarioId: 'clear-day', locationId: 'reference', units: 'C', household: 'older-man', scenarioStartedAt: '2026-10-19T06:00:00.000Z' } as const;
  const fresh = (): SandboxPlay => ({ entry: {} as SandboxPlay['entry'], forecast: () => ({}) as ReturnType<SandboxPlay['forecast']>, units: 'C', household: 'older-man', place: 'reference', scenario: {} as SandboxPlay['scenario'], startMs: 0, firstStart });
  const notFound = err(toolError('settings_not_found', 'None.'));
  const storeOf = (put: Awaited<ReturnType<StateStore['putSandboxSettings']>>, reads: Awaited<ReturnType<StateStore['getSandboxSettings']>>[]) => {
    const puts: [SandboxSettings, number | undefined][] = [];
    const factory: StateStoreFactory = () =>
      ({
        getSandboxSettings: () => Promise.resolve(reads.shift() ?? notFound),
        putSandboxSettings: (s: SandboxSettings, expected: number | undefined) => {
          puts.push([s, expected]);
          return Promise.resolve(put);
        },
      }) as unknown as StateStore;
    return { factory, puts };
  };

  it('stores it create-if-absent as version 1 and keeps playing it, with no warning', async () => {
    const logger = memoryLogger();
    const { factory, puts } = storeOf(ok(undefined), [notFound]);
    const played = await refreshFrom(factory, () => ok(fresh()), logger, clock)(A, fresh(), 'c');
    expect(puts).toEqual([[{ ...firstStart, version: 1, updatedAt: '2026-10-19T07:00:00.000Z' }, undefined]]);
    expect(played.version).toBe(1);
    expect(played.firstStart).toBeUndefined();
    expect(logger.lines).toEqual([]);
  });

  it('plays the start another container stored first', async () => {
    const logger = memoryLogger();
    const theirs = SandboxSettingsSchema.parse({ ...firstStart, version: 1, updatedAt: '2026-10-19T06:59:00Z', scenarioStartedAt: '2026-10-19T05:00:00.000Z' });
    const { factory } = storeOf(err(toolError('settings_version_conflict', 'Taken.')), [notFound, ok(theirs)]);
    const adopted: SandboxPlay = { ...fresh(), version: 1, startMs: 1 };
    const seen: SandboxSettings[] = [];
    const playing = (_h: unknown, s: SandboxSettings) => {
      seen.push(s);
      return ok(adopted);
    };
    expect(await refreshFrom(factory, playing, logger, clock)(A, fresh(), 'c')).toBe(adopted);
    expect(seen).toEqual([theirs]);
    expect(logger.lines).toEqual([]);
  });

  it('keeps its own start when the store fails, and logs it with its code, never the home', async () => {
    const logger = memoryLogger();
    const { factory } = storeOf(err(toolError('store_unavailable', 'Down.')), [notFound]);
    const current = fresh();
    expect(await refreshFrom(factory, () => ok(fresh()), logger, clock)(A, current, 'c')).toBe(current);
    expect(logger.lines.map((l) => [l.level, l.code, l.details?.['event']])).toEqual([['warn', 'store_unavailable', 'settings_first_start_failed']]);
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  });
});
