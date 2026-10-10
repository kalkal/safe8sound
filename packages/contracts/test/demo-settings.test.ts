import { describe, expect, it } from 'vitest';
import {
  AdvanceClockInputSchema,
  AdvanceClockOutputSchema,
  GetDemoSettingsOutputSchema,
  GetMilestonesInputSchema,
  GetMilestonesOutputSchema,
  SandboxSettingsSchema,
  SetScenarioInputSchema,
  SetScenarioOutputSchema,
} from '../src/index.js';

// C2b (#222, approved in #222): the visitor's sandbox settings as two tools. Additive: nothing else changes.

const settings = { version: 2, updatedAt: '2026-10-04T10:00:00Z', scenarioId: 'storm-blackout', locationId: 'reference', units: 'C', household: 'older-man' } as const;

describe('get_demo_settings output', () => {
  it('carries the settings and the place they are played in', () => {
    expect(GetDemoSettingsOutputSchema.parse({ settings, place: { id: 'reference', label: 'Reference home', tz: 'Europe/Rome' } })).toMatchObject({ place: { id: 'reference' } });
  });

  it('refuses an unknown field or a place without a zone', () => {
    expect(GetDemoSettingsOutputSchema.safeParse({ settings, place: { id: 'reference', label: 'x', tz: 'Europe/Rome' }, extra: 1 }).success).toBe(false);
    expect(GetDemoSettingsOutputSchema.safeParse({ settings, place: { id: 'reference', label: 'x', tz: '' } }).success).toBe(false);
  });
});

describe('set_scenario input', () => {
  it('takes any of the choices, alone or together', () => {
    expect(SetScenarioInputSchema.parse({ scenarioId: 'heatwave' })).toEqual({ scenarioId: 'heatwave' });
    expect(SetScenarioInputSchema.parse({ locationId: 'houston', household: 'older-woman', units: 'F', restart: true })).toMatchObject({ restart: true });
    expect(SetScenarioInputSchema.parse({ restart: true })).toEqual({ restart: true });
  });

  it('needs at least one field, and refuses unknown fields and values', () => {
    expect(SetScenarioInputSchema.safeParse({}).success).toBe(false);
    expect(SetScenarioInputSchema.safeParse({ restart: false }).success).toBe(false);
    expect(SetScenarioInputSchema.safeParse({ scenarioId: 'tornado' }).success).toBe(false);
    expect(SetScenarioInputSchema.safeParse({ units: 'K' }).success).toBe(false);
    expect(SetScenarioInputSchema.safeParse({ scenarioId: 'heatwave', comfortC: 20 }).success).toBe(false);
  });
});

describe('set_scenario output', () => {
  it('carries the new settings and whether the day started again', () => {
    expect(SetScenarioOutputSchema.parse({ settings, restarted: true })).toEqual({ settings, restarted: true });
    expect(SetScenarioOutputSchema.safeParse({ settings }).success).toBe(false);
  });
});

// #311 (approved in #311): the judges' clock. Additive: two tools and an optional field of the settings.
describe('sandbox settings: advancedMs', () => {
  it('is optional, a whole number of scenario ms, never negative', () => {
    expect(SandboxSettingsSchema.parse(settings)).toEqual(settings);
    expect(SandboxSettingsSchema.parse({ ...settings, advancedMs: 3_600_000 })).toMatchObject({ advancedMs: 3_600_000 });
    expect(SandboxSettingsSchema.safeParse({ ...settings, advancedMs: -1 }).success).toBe(false);
    expect(SandboxSettingsSchema.safeParse({ ...settings, advancedMs: 1.5 }).success).toBe(false);
  });
});

describe('get_milestones', () => {
  const output = {
    now: '2026-07-17T09:00:00+02:00',
    day: { from: '2026-07-17T00:00:00+02:00', to: '2026-07-18T00:00:00+02:00' },
    milestones: [{ kind: 'storm_start', at: '2026-07-17T10:00:00+02:00', label: 'The storm starts: the grid goes down' }],
  };

  it('takes an optional plan id and nothing else', () => {
    expect(GetMilestonesInputSchema.parse({})).toEqual({});
    expect(GetMilestonesInputSchema.parse({ planId: 'plan_0123456789abcdef' })).toEqual({ planId: 'plan_0123456789abcdef' });
    expect(GetMilestonesInputSchema.safeParse({ homeId: 'home' }).success).toBe(false);
  });

  it('carries now, the day and at most 12 milestones of known kinds', () => {
    expect(GetMilestonesOutputSchema.parse(output)).toEqual(output);
    const many = Array.from({ length: 13 }, () => output.milestones[0]);
    expect(GetMilestonesOutputSchema.safeParse({ ...output, milestones: many }).success).toBe(false);
    expect(GetMilestonesOutputSchema.safeParse({ ...output, milestones: [{ ...output.milestones[0], kind: 'lunch' }] }).success).toBe(false);
  });
});

describe('advance_clock', () => {
  it('takes a listed milestone (kind and at) or a number of hours from 1 to 24, with an optional plan', () => {
    expect(AdvanceClockInputSchema.parse({ kind: 'storm_start', at: '2026-07-17T10:00:00+02:00' })).toMatchObject({ kind: 'storm_start' });
    expect(AdvanceClockInputSchema.parse({ hours: 24, planId: 'plan_0123456789abcdef' })).toMatchObject({ hours: 24 });
  });

  it('refuses both at once, neither, a kind without its time, 0 or more than 24 hours', () => {
    expect(AdvanceClockInputSchema.safeParse({}).success).toBe(false);
    expect(AdvanceClockInputSchema.safeParse({ kind: 'storm_start' }).success).toBe(false);
    expect(AdvanceClockInputSchema.safeParse({ kind: 'storm_start', at: '2026-07-17T10:00:00+02:00', hours: 1 }).success).toBe(false);
    expect(AdvanceClockInputSchema.safeParse({ hours: 0 }).success).toBe(false);
    expect(AdvanceClockInputSchema.safeParse({ hours: 25 }).success).toBe(false);
    expect(AdvanceClockInputSchema.safeParse({ hours: -1 }).success).toBe(false);
  });

  it('answers the new time and the settings version', () => {
    expect(AdvanceClockOutputSchema.parse({ now: '2026-07-17T10:00:00+02:00', settingsVersion: 3 })).toMatchObject({ settingsVersion: 3 });
    expect(AdvanceClockOutputSchema.safeParse({ now: '2026-07-17T10:00:00+02:00' }).success).toBe(false);
  });
});
