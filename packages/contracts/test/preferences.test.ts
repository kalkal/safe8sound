import { describe, expect, it } from 'vitest';
import { examplePreferences, exampleSafetyLimits } from '../src/fixtures.js';
import {
  ConfigChangeSchema,
  PreferencesSchema,
  ELDERLY_CAP_MAX_C,
  HEAT_INDEX_CAP_MAX_C,
  SafetyHardLimitsSchema,
  checkSafetyWithinLimits,
  effectiveHeatSafety,
} from '../src/index.js';

describe('PreferencesSchema', () => {
  it('parses the example preferences', () => {
    const prefs = PreferencesSchema.parse(examplePreferences());
    expect(prefs.roomPriority[0]).toBe(prefs.safeRoomId);
  });

  it('always puts the safe room first in the room priority', () => {
    const input = examplePreferences();
    expect(PreferencesSchema.safeParse({ ...input, roomPriority: [...input.roomPriority].reverse() }).success).toBe(false);
  });

  it('rejects repeated rooms in the priority', () => {
    const input = examplePreferences();
    expect(PreferencesSchema.safeParse({ ...input, roomPriority: [...input.roomPriority, input.safeRoomId] }).success).toBe(false);
  });

  it('allows at most three family contacts', () => {
    const input = examplePreferences();
    const contact = { role: 'daughter', name: 'Ana', channel: 'in_app', handle: 'phone-1' };
    expect(PreferencesSchema.safeParse({ ...input, familyContacts: [contact, contact, contact] }).success).toBe(true);
    expect(PreferencesSchema.safeParse({ ...input, familyContacts: [contact, contact, contact, contact] }).success).toBe(false);
  });

  it('keeps the humidity band ordered', () => {
    const input = examplePreferences();
    input.safety.humidity = { minPct: 60, maxPct: 40 };
    expect(PreferencesSchema.safeParse(input).success).toBe(false);
  });

  it('keeps the comfort setpoints inside the safety thresholds of each season', () => {
    const input = examplePreferences();
    input.comfortC.cooling = input.safety.cooling.maxC + 1;
    expect(PreferencesSchema.safeParse(input).success).toBe(false);
  });
});

describe('checkSafetyWithinLimits (hard limits from config)', () => {
  const limits = SafetyHardLimitsSchema.parse(exampleSafetyLimits());

  it('accepts thresholds inside the hard limits', () => {
    const prefs = PreferencesSchema.parse(examplePreferences());
    expect(checkSafetyWithinLimits(prefs.safety, limits)).toEqual({ ok: true, value: prefs.safety });
  });

  it('rejects a threshold outside the hard limits with the nearest allowed value', () => {
    const input = examplePreferences();
    input.safety.cooling.maxC = 35;
    input.comfortC.cooling = 26;
    const prefs = PreferencesSchema.parse(input);
    const result = checkSafetyWithinLimits(prefs.safety, limits);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'safety_threshold_out_of_range',
        category: 'validation',
        retryable: false,
        details: { field: 'safety.cooling.maxC', limit: limits.cooling.maxC.max, nearestAllowed: limits.cooling.maxC.max, unit: 'C' },
      },
    });
  });

  it('checks the heating minimum and the humidity band too', () => {
    const input = examplePreferences();
    input.safety.heating.minC = 10;
    const heating = checkSafetyWithinLimits(PreferencesSchema.parse(input).safety, limits);
    expect(heating).toMatchObject({ ok: false, error: { details: { field: 'safety.heating.minC' } } });

    const humid = examplePreferences();
    humid.safety.humidity.maxPct = 90;
    const humidity = checkSafetyWithinLimits(PreferencesSchema.parse(humid).safety, limits);
    expect(humidity).toMatchObject({ ok: false, error: { details: { field: 'safety.humidity.maxPct', unit: '%' } } });
  });

  it('rejects hard limits whose default lies outside their own range', () => {
    const input = exampleSafetyLimits();
    input.cooling.maxC.default = 40;
    expect(SafetyHardLimitsSchema.safeParse(input).success).toBe(false);
  });
});

describe('heat safety settings (#266, approved in #248): only stricter, never looser', () => {
  const limits = SafetyHardLimitsSchema.parse({
    ...exampleSafetyLimits(),
    stricterNightLimit: { default: false },
    heatIndexCapC: { min: 26.7, max: 32.2, default: 32.2 },
    elderlyCapC: { min: 26, max: 31, default: 31 },
  });
  const withSafety = (extra: Record<string, unknown>) => {
    const input = examplePreferences() as { safety: Record<string, unknown> };
    input.safety = { ...input.safety, ...extra };
    return PreferencesSchema.parse(input);
  };

  it('the health constants are the NWS Extreme Caution start and Health Canada critical limit for older adults', () => {
    expect(HEAT_INDEX_CAP_MAX_C).toBe(32.2);
    expect(ELDERLY_CAP_MAX_C).toBe(31);
  });

  it('stored preferences without the new fields still parse, and play the defaults', () => {
    const prefs = PreferencesSchema.parse(examplePreferences());
    expect(prefs.safety.stricterNightLimit).toBeUndefined();
    expect(effectiveHeatSafety(prefs.safety)).toEqual({ stricterNightLimit: false, heatIndexCapC: 32.2, elderlyCapC: 31 });
  });

  it('keeps a stricter choice', () => {
    const prefs = withSafety({ stricterNightLimit: true, heatIndexCapC: 30, elderlyCapC: 28 });
    expect(effectiveHeatSafety(prefs.safety)).toEqual({ stricterNightLimit: true, heatIndexCapC: 30, elderlyCapC: 28 });
    expect(checkSafetyWithinLimits(prefs.safety, limits).ok).toBe(true);
  });

  it('on write, refuses a looser cap with the nearest allowed value, and a cap below its bound', () => {
    expect(checkSafetyWithinLimits(withSafety({ heatIndexCapC: 33 }).safety, limits)).toMatchObject({
      ok: false,
      error: { code: 'safety_threshold_out_of_range', details: { field: 'safety.heatIndexCapC', nearestAllowed: 32.2, unit: 'C' } },
    });
    expect(checkSafetyWithinLimits(withSafety({ elderlyCapC: 32 }).safety, limits)).toMatchObject({ ok: false, error: { details: { field: 'safety.elderlyCapC', nearestAllowed: 31 } } });
    expect(checkSafetyWithinLimits(withSafety({ elderlyCapC: 25 }).safety, limits)).toMatchObject({ ok: false, error: { details: { field: 'safety.elderlyCapC', nearestAllowed: 26 } } });
  });

  it('on read, a looser stored cap is clamped to the health constant', () => {
    expect(effectiveHeatSafety(withSafety({ heatIndexCapC: 35, elderlyCapC: 33 }).safety)).toMatchObject({ heatIndexCapC: 32.2, elderlyCapC: 31 });
  });

  it('refuses hard limits that would allow a looser cap than the health constants', () => {
    const looser = { ...exampleSafetyLimits(), heatIndexCapC: { min: 26.7, max: 33, default: 32.2 } };
    expect(SafetyHardLimitsSchema.safeParse(looser).success).toBe(false);
    const elderly = { ...exampleSafetyLimits(), elderlyCapC: { min: 26, max: 32, default: 31 } };
    expect(SafetyHardLimitsSchema.safeParse(elderly).success).toBe(false);
  });
});

describe('ConfigChangeSchema', () => {
  const change = { ts: '2026-09-28T12:00:00+02:00', field: 'safety.cooling.maxC', from: 27, to: 28, by: 'user', confirmed: true };

  it('records who changed what, always confirmed', () => {
    expect(ConfigChangeSchema.safeParse(change).success).toBe(true);
    expect(ConfigChangeSchema.safeParse({ ...change, confirmed: false }).success).toBe(false);
    expect(ConfigChangeSchema.safeParse({ ...change, by: 'agent' }).success).toBe(false);
  });

  it('says through which path the confirmation came (optional, approved in #20)', () => {
    expect(ConfigChangeSchema.safeParse({ ...change, confirmedVia: 'tool' }).success).toBe(true);
    expect(ConfigChangeSchema.safeParse({ ...change, confirmedVia: 'app' }).success).toBe(true);
    expect(ConfigChangeSchema.safeParse({ ...change, confirmedVia: 'telepathy' }).success).toBe(false);
  });
});
