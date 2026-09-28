import { describe, expect, it } from 'vitest';
import { examplePreferences, exampleSafetyLimits } from '../src/fixtures.js';
import {
  ConfigChangeSchema,
  PreferencesSchema,
  SafetyHardLimitsSchema,
  checkSafetyWithinLimits,
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
    const contact = { role: 'daughter', name: 'Anna', channel: 'in_app', handle: 'phone-1' };
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

describe('ConfigChangeSchema', () => {
  const change = { ts: '2026-09-28T12:00:00+02:00', field: 'safety.cooling.maxC', from: 27, to: 28, by: 'user', confirmed: true };

  it('records who changed what, always confirmed', () => {
    expect(ConfigChangeSchema.safeParse(change).success).toBe(true);
    expect(ConfigChangeSchema.safeParse({ ...change, confirmed: false }).success).toBe(false);
    expect(ConfigChangeSchema.safeParse({ ...change, by: 'agent' }).success).toBe(false);
  });
});
