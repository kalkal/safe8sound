import { describe, expect, it } from 'vitest';
import {
  AdminSettingsSchema,
  LocationIdSchema,
  SandboxSettingsSchema,
  ScenarioIdSchema,
  categoryOf,
  clampAdminCaps,
  type AdminCaps,
} from '../src/index.js';

// C1 (#214, approved in #214): the settings of one visitor's sandbox and the demo's admin config. Structural
// bounds only: the deployed ceilings ("caps can only be lowered") are enforced by the sim-api when it writes,
// and by clampAdminCaps when it reads. Health thresholds are not settings.

const SANDBOX = {
  version: 1,
  updatedAt: '2026-10-04T01:50:00+02:00',
  scenarioId: 'heatwave',
  locationId: 'turin',
  units: 'C',
  household: 'older-woman',
};

const CAPS: AdminCaps = {
  turnsPerCodePerDay: 20,
  turnsGlobalPerDay: 30,
  toolCallsPerCodePerDay: 20,
  codeAttemptsPerIpPerHour: 10,
  sandboxesPerDay: 50,
  speechCharsPerCodePerDay: 6000,
  speechCharsGlobalPerDay: 30_000,
};

describe('scenario and place ids', () => {
  it('lists the built-in scenarios and the places', () => {
    expect(ScenarioIdSchema.options).toEqual(['clear-day', 'heatwave', 'storm-blackout']);
    expect(LocationIdSchema.options).toEqual(['reference', 'turin', 'houston']);
  });
});

describe('SandboxSettingsSchema', () => {
  it('accepts the settings of a sandbox, with or without a storm start charge', () => {
    expect(SandboxSettingsSchema.safeParse(SANDBOX).success).toBe(true);
    expect(SandboxSettingsSchema.safeParse({ ...SANDBOX, stormStartSoc: 45 }).success).toBe(true);
    expect(SandboxSettingsSchema.safeParse({ ...SANDBOX, stormStartSoc: 'from-reserve' }).success).toBe(true);
  });

  it('accepts the wall instant the day was last started from (C2b, approved in #222)', () => {
    expect(SandboxSettingsSchema.safeParse({ ...SANDBOX, scenarioStartedAt: '2026-10-04T10:00:00Z' }).success).toBe(true);
  });

  it.each([
    ['an unknown scenario', { scenarioId: 'blizzard' }],
    ['an unknown place', { locationId: 'paris' }],
    ['other units', { units: 'K' }],
    ['another household', { household: 'everyone' }],
    ['a storm charge below 30 %', { stormStartSoc: 29 }],
    ['a storm charge above 100 %', { stormStartSoc: 101 }],
    ['a fractional storm charge', { stormStartSoc: 45.5 }],
    ['version 0', { version: 0 }],
    ['a start that is not an ISO instant', { scenarioStartedAt: 'this morning' }],
    ['an extra field (a home id, a threshold)', { homeId: 'home' }],
    ['a health threshold (not a setting)', { comfortC: 26 }],
  ])('refuses %s', (_case, change) => {
    expect(SandboxSettingsSchema.safeParse({ ...SANDBOX, ...change }).success).toBe(false);
  });
});

describe('AdminSettingsSchema', () => {
  const ADMIN = { version: 3, updatedAt: '2026-10-04T01:50:00Z', demoEnabled: true, caps: CAPS, sandboxDefaults: SANDBOX };

  it('accepts the admin config with its caps and the defaults of a new sandbox', () => {
    expect(AdminSettingsSchema.safeParse(ADMIN).success).toBe(true);
  });

  it('keeps bounds structural: positive whole numbers, nothing more', () => {
    expect(AdminSettingsSchema.safeParse({ ...ADMIN, caps: { ...CAPS, turnsGlobalPerDay: 0 } }).success).toBe(false);
    expect(AdminSettingsSchema.safeParse({ ...ADMIN, caps: { ...CAPS, turnsGlobalPerDay: 2.5 } }).success).toBe(false);
    expect(AdminSettingsSchema.safeParse({ ...ADMIN, caps: { ...CAPS, extra: 1 } }).success).toBe(false);
  });
});

describe('clampAdminCaps: a stored cap never exceeds the deployed ceiling when read', () => {
  it('lowers each cap above the ceiling to it, and keeps the lower ones', () => {
    const ceiling: AdminCaps = { ...CAPS, turnsGlobalPerDay: 100, speechCharsGlobalPerDay: 30_000 };
    const stored: AdminCaps = { ...CAPS, turnsGlobalPerDay: 5000, speechCharsGlobalPerDay: 10_000 };
    expect(clampAdminCaps(stored, ceiling)).toEqual({ ...CAPS, turnsGlobalPerDay: 100, speechCharsGlobalPerDay: 10_000 });
  });
});

describe('the settings error codes', () => {
  it('a stale version is a conflict (a value, never a throw); missing settings are not_found', () => {
    expect(categoryOf('settings_version_conflict')).toBe('conflict');
    expect(categoryOf('settings_not_found')).toBe('not_found');
  });
});
