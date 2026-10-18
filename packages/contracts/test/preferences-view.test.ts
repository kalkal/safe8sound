import { describe, expect, it } from 'vitest';
import { examplePreferences, exampleSafetyLimits } from '../src/fixtures.js';
import {
  GetPreferencesOutputSchema,
  PreferencesSchema,
  PublicPreferencesSchema,
  SafetyHardLimitsSchema,
  SetPreferencesInputSchema,
  SetPreferencesOutputSchema,
  toPublicPreferences,
} from '../src/index.js';

// The preferences as the tools and the cards see them (approved in #21): contacts by role and
// channel only, so names and handles never reach the model or a card.

const preferences = () => PreferencesSchema.parse(examplePreferences());

describe('toPublicPreferences', () => {
  it('keeps everything a card or the model needs, and drops contact names and handles', () => {
    const view = toPublicPreferences(preferences());
    expect(view.contacts).toEqual([{ role: 'daughter', channel: 'in_app' }]);
    expect(JSON.stringify(view)).not.toContain('Example Contact');
    expect(JSON.stringify(view)).not.toContain('phone-1');
    expect(PublicPreferencesSchema.parse(view)).toEqual(view);
  });
});

describe('PublicPreferencesSchema', () => {
  it('refuses a contact that carries a name', () => {
    const view = { ...toPublicPreferences(preferences()), contacts: [{ role: 'daughter', channel: 'in_app', name: 'Example Contact' }] };
    expect(PublicPreferencesSchema.safeParse(view).success).toBe(false);
  });
});

describe('get_preferences and set_preferences shapes', () => {
  it('get_preferences returns the public view, whether it is the default, and the hard limits', () => {
    const output = { preferences: toPublicPreferences(preferences()), isDefault: true, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
    expect(GetPreferencesOutputSchema.parse(output)).toEqual(output);
    expect(GetPreferencesOutputSchema.safeParse({ ...output, isDefault: 'yes' }).success).toBe(false);
  });

  it('#422: get_preferences may name the rooms for the cards (optional, additive); old outputs stay valid', () => {
    const output = { preferences: toPublicPreferences(preferences()), isDefault: true, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
    const rooms = [{ id: 'bedroom-1', name: "Leo's room" }, { id: 'living', name: 'Living room' }];
    expect(GetPreferencesOutputSchema.parse({ ...output, rooms }).rooms).toEqual(rooms);
    expect(GetPreferencesOutputSchema.parse(output).rooms).toBeUndefined();
    expect(GetPreferencesOutputSchema.safeParse({ ...output, rooms: [{ id: 'living', name: '' }] }).success).toBe(false);
    expect(GetPreferencesOutputSchema.safeParse({ ...output, rooms: [{ id: 'living', name: 'Living', occupant: 'Leo' }] }).success).toBe(false);
  });

  it('set_preferences takes a partial change, only once the person confirmed it', () => {
    expect(SetPreferencesInputSchema.safeParse({ comfortC: { cooling: 24 }, confirmed: true }).success).toBe(true);
    expect(SetPreferencesInputSchema.safeParse({ comfortC: { cooling: 24 } }).success).toBe(false);
    expect(SetPreferencesInputSchema.safeParse({ comfortC: { cooling: 24 }, confirmed: false }).success).toBe(false);
    expect(SetPreferencesInputSchema.safeParse({ familyContacts: [], confirmed: true }).success).toBe(false);
  });

  it('set_preferences returns the new public view and the logged changes', () => {
    const output = {
      preferences: toPublicPreferences(preferences()),
      changes: [{ ts: '2026-07-15T14:05:00+02:00', field: 'comfortC.cooling', from: 25, to: 24, by: 'user', confirmed: true }],
    };
    expect(SetPreferencesOutputSchema.parse(output)).toEqual(output);
  });
});
