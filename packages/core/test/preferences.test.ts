import { PreferencesSchema, SafetyHardLimitsSchema } from '@cold-reserve/contracts';
import { examplePreferences, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { updatePreferences, type PreferencesUpdateContext } from '../src/preferences.js';

const current = () => PreferencesSchema.parse(examplePreferences());
const limits = SafetyHardLimitsSchema.parse(exampleSafetyLimits());
const ctx: PreferencesUpdateContext = { limits, roomIds: ['bedroom-1', 'living', 'study'], at: '2026-07-15T12:00:00Z', by: 'user' };
const contact = (role: string) => ({ role, name: 'Example Contact', channel: 'in_app' as const, handle: `phone-${role}` });

describe('updatePreferences', () => {
  it('applies a valid update and records one confirmed change per changed field', () => {
    const result = updatePreferences(current(), { safety: { cooling: { maxC: 28 } }, language: 'it-IT' }, ctx);
    expect(result).toMatchObject({ ok: true, value: { preferences: { safety: { cooling: { maxC: 28 } }, language: 'it-IT' } } });
    expect(result.ok && result.value.changes).toEqual([
      { ts: ctx.at, field: 'safety.cooling.maxC', from: 27, to: 28, by: 'user', confirmed: true },
      { ts: ctx.at, field: 'language', from: 'en-US', to: 'it-IT', by: 'user', confirmed: true },
    ]);
  });

  it('records nothing when nothing changes', () => {
    expect(updatePreferences(current(), { comfortC: { cooling: 25 } }, ctx)).toMatchObject({ ok: true, value: { changes: [] } });
  });

  it('marks changes declared by a scenario', () => {
    const result = updatePreferences(current(), { comfortC: { heating: 21 } }, { ...ctx, by: 'scenario' });
    expect(result.ok && result.value.changes[0]?.by).toBe('scenario');
  });

  it('keeps every safety threshold inside the hard limits from config', () => {
    const result = updatePreferences(current(), { safety: { cooling: { maxC: 35 } } }, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'safety_threshold_out_of_range', details: { field: 'safety.cooling.maxC', nearestAllowed: 30 } },
    });
  });

  it('never lets an accepted update leave the hard limits (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: -60, max: 80, noNaN: true }), (maxC) => {
        const result = updatePreferences(current(), { safety: { cooling: { maxC } }, comfortC: { cooling: Math.min(maxC, 25) } }, ctx);
        if (result.ok) {
          const saved = result.value.preferences.safety.cooling.maxC;
          expect(saved).toBeGreaterThanOrEqual(limits.cooling.maxC.min);
          expect(saved).toBeLessThanOrEqual(limits.cooling.maxC.max);
        }
      }),
    );
  });

  it('refuses a comfort setpoint outside the safety thresholds of its season', () => {
    expect(updatePreferences(current(), { comfortC: { cooling: 29 } }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'invalid_setpoint', details: { field: 'comfortC.cooling', limit: 27, nearestAllowed: 27 } },
    });
    expect(updatePreferences(current(), { comfortC: { heating: 16 } }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'invalid_setpoint', details: { field: 'comfortC.heating', limit: 18, nearestAllowed: 18 } },
    });
  });

  it('allows at most three family contacts and logs only how many, never names', () => {
    const three = updatePreferences(current(), { familyContacts: [contact('son'), contact('daughter'), contact('neighbour')] }, ctx);
    expect(three.ok && three.value.changes).toEqual([
      { ts: ctx.at, field: 'familyContacts.count', from: 1, to: 3, by: 'user', confirmed: true },
    ]);
    const four = updatePreferences(current(), { familyContacts: ['son', 'daughter', 'neighbour', 'friend'].map(contact) }, ctx);
    expect(four).toMatchObject({ ok: false, error: { code: 'invalid_input', details: { field: 'familyContacts' } } });
  });

  it('moves a new safe room to the top of the priority', () => {
    const result = updatePreferences(current(), { safeRoomId: 'study' }, ctx);
    expect(result.ok && result.value.preferences.roomPriority).toEqual(['study', 'bedroom-1', 'living']);
  });

  it('refuses a priority that does not start with the safe room', () => {
    expect(updatePreferences(current(), { roomPriority: ['living', 'bedroom-1', 'study'] }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', details: { field: 'roomPriority' } },
    });
  });

  it('refuses rooms the home does not have', () => {
    expect(updatePreferences(current(), { safeRoomId: 'attic' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'unknown_room', details: { roomId: 'attic' } },
    });
    expect(updatePreferences(current(), { roomPriority: ['bedroom-1', 'attic'] }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'unknown_room', details: { roomId: 'attic' } },
    });
  });
});
