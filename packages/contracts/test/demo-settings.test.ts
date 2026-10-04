import { describe, expect, it } from 'vitest';
import { GetDemoSettingsOutputSchema, SetScenarioInputSchema, SetScenarioOutputSchema } from '../src/index.js';

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
