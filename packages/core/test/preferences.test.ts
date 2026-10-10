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

  it('never lets an accepted update leave the heating and humidity hard limits (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -60, max: 80, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (minC, minPct, maxPct) => {
          const update = { safety: { heating: { minC }, humidity: { minPct, maxPct } }, comfortC: { heating: Math.max(minC, 20) } };
          const result = updatePreferences(current(), update, ctx);
          if (result.ok) {
            const s = result.value.preferences.safety;
            expect(s.heating.minC).toBeGreaterThanOrEqual(limits.heating.minC.min);
            expect(s.heating.minC).toBeLessThanOrEqual(limits.heating.minC.max);
            expect(s.humidity.minPct).toBeGreaterThanOrEqual(limits.humidity.minPct.min);
            expect(s.humidity.minPct).toBeLessThanOrEqual(limits.humidity.minPct.max);
            expect(s.humidity.maxPct).toBeGreaterThanOrEqual(limits.humidity.maxPct.min);
            expect(s.humidity.maxPct).toBeLessThanOrEqual(limits.humidity.maxPct.max);
          }
        },
      ),
    );
  });

  it.each([
    ['safety.cooling.maxC', (v: number) => ({ safety: { cooling: { maxC: v } }, comfortC: { cooling: Math.min(v, 24) } }), limits.cooling.maxC],
    ['safety.heating.minC', (v: number) => ({ safety: { heating: { minC: v } }, comfortC: { heating: Math.max(v, 16) } }), limits.heating.minC],
    ['safety.humidity.minPct', (v: number) => ({ safety: { humidity: { minPct: v } } }), limits.humidity.minPct],
    ['safety.humidity.maxPct', (v: number) => ({ safety: { humidity: { maxPct: v } } }), limits.humidity.maxPct],
  ] as const)('%s: accepts the hard limit at min and max, refuses max + epsilon', (field, update, bound) => {
    expect(updatePreferences(current(), update(bound.min), ctx).ok).toBe(true);
    expect(updatePreferences(current(), update(bound.max), ctx).ok).toBe(true);
    expect(updatePreferences(current(), update(bound.max + 0.001), ctx)).toMatchObject({
      ok: false,
      error: { code: 'safety_threshold_out_of_range', details: { field, nearestAllowed: bound.max } },
    });
  });

  it('refuses a humidity band whose minimum is not below its maximum', () => {
    expect(updatePreferences(current(), { safety: { humidity: { minPct: 50, maxPct: 50 } } }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', details: { field: 'safety' } },
    });
  });

  it('reports a final schema failure (repeated rooms) as invalid_input with the issues', () => {
    const result = updatePreferences(current(), { roomPriority: ['bedroom-1', 'living', 'living'] }, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(!result.ok && result.error.details?.issues?.[0]?.path).toBe('roomPriority');
  });

  it('records the path the confirmation came through when the caller knows it', () => {
    const result = updatePreferences(current(), { language: 'it-IT' }, { ...ctx, confirmedVia: 'tool' });
    expect(result.ok && result.value.changes).toEqual([
      { ts: ctx.at, field: 'language', from: 'en-US', to: 'it-IT', by: 'user', confirmed: true, confirmedVia: 'tool' },
    ]);
  });

  it('in a °F sandbox the refusals say °F with the °C to send in brackets; the details stay in °C (#306 review)', () => {
    const f = { ...ctx, unit: 'F' as const };
    const setpoint = updatePreferences(current(), { comfortC: { cooling: 29 } }, f);
    expect(setpoint).toMatchObject({ ok: false, error: { code: 'invalid_setpoint', message: 'comfortC.cooling must stay within the safety threshold (80.6 °F (27 C)).', details: { limit: 27, unit: 'C' } } });
    const range = updatePreferences(current(), { safety: { cooling: { maxC: 35 } } }, f);
    expect(range).toMatchObject({ ok: false, error: { code: 'safety_threshold_out_of_range', details: { field: 'safety.cooling.maxC', unit: 'C' } } });
    expect(!range.ok && range.error.message).toMatch(/^safety\.cooling\.maxC must stay between \d+(\.\d)? °F \(\d+ C\) and \d+(\.\d)? °F \(\d+ C\)\.$/);
    // A percentage stays a percentage.
    const rh = updatePreferences(current(), { safety: { humidity: { maxPct: 99 } } }, f);
    expect(!rh.ok && rh.error.message).toMatch(/ %\.$/);
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

  it('#312: refuses a heating comfort above the cooling safety maximum: no room is heated past the limit it is cooled to', () => {
    expect(updatePreferences(current(), { comfortC: { heating: 68 } }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'invalid_setpoint', details: { field: 'comfortC.heating', limit: 27, nearestAllowed: 27, unit: 'C' } },
    });
    expect(updatePreferences(current(), { comfortC: { heating: 27.5 } }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid_setpoint' } });
    expect(updatePreferences(current(), { comfortC: { heating: 27 } }, ctx)).toMatchObject({ ok: true });
  });

  it('#312: in a °F sandbox a comfort above 40 is a °F number sent as °C: refused with the °C to send, nothing saved as 68 °C', () => {
    const f = { ...ctx, unit: 'F' as const };
    expect(updatePreferences(current(), { comfortC: { heating: 68 } }, f)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', message: 'Temperatures are sent in Celsius: 68 looks like °F. 68 °F is 20 °C: send comfortC.heating 20.', details: { field: 'comfortC.heating' } },
    });
    expect(updatePreferences(current(), { comfortC: { cooling: 75 } }, f)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', message: 'Temperatures are sent in Celsius: 75 looks like °F. 75 °F is 23.9 °C: send comfortC.cooling 23.9.', details: { field: 'comfortC.cooling' } },
    });
    // In °C the same number is just out of range, said as such.
    expect(updatePreferences(current(), { comfortC: { cooling: 75 } }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid_setpoint' } });
    // A sensible °C value in a °F sandbox is saved.
    expect(updatePreferences(current(), { comfortC: { heating: 20 } }, f)).toMatchObject({ ok: true });
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

describe('heat safety settings (#266): only stricter, logged like any change', () => {
  const capped = SafetyHardLimitsSchema.parse({ ...exampleSafetyLimits(), stricterNightLimit: { default: false }, heatIndexCapC: { min: 26.7, max: 32.2, default: 32.2 }, elderlyCapC: { min: 26, max: 31, default: 31 } });
  const cctx = { ...ctx, limits: capped };

  it('turns the stricter night limit on and tightens both caps, one logged change each (defaults as "from")', () => {
    const result = updatePreferences(current(), { safety: { stricterNightLimit: true, heatIndexCapC: 30, elderlyCapC: 28 } }, cctx);
    expect(result).toMatchObject({ ok: true, value: { preferences: { safety: { stricterNightLimit: true, heatIndexCapC: 30, elderlyCapC: 28 } } } });
    expect(result.ok && result.value.changes.map((c) => [c.field, c.from, c.to])).toEqual([
      ['safety.stricterNightLimit', false, true],
      ['safety.heatIndexCapC', 32.2, 30],
      ['safety.elderlyCapC', 31, 28],
    ]);
  });

  it('refuses a looser cap with the nearest allowed value', () => {
    expect(updatePreferences(current(), { safety: { heatIndexCapC: 34 } }, cctx)).toMatchObject({ ok: false, error: { code: 'safety_threshold_out_of_range', details: { field: 'safety.heatIndexCapC', nearestAllowed: 32.2 } } });
    expect(updatePreferences(current(), { safety: { elderlyCapC: 31.5 } }, cctx)).toMatchObject({ ok: false, error: { details: { field: 'safety.elderlyCapC', nearestAllowed: 31 } } });
  });

  it('keeps the other settings when one changes', () => {
    const first = updatePreferences(current(), { safety: { heatIndexCapC: 30 } }, cctx);
    if (!first.ok) throw new Error(first.error.message);
    const second = updatePreferences(first.value.preferences, { safety: { stricterNightLimit: true } }, cctx);
    expect(second.ok && second.value.preferences.safety).toMatchObject({ heatIndexCapC: 30, stricterNightLimit: true });
  });
});
