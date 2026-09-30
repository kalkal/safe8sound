import { SENDABLE_TRANSITIONS } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME, stormMessage, stormPreview } from '../src/index.js';

const fields = { name: 'Anna', room: 'Bedroom', tempC: '26.4', safeUntil: '7:30' };

describe('storm family messages (Mileti: source, hazard, place, status, time, what to do)', () => {
  it('has a template for every transition that is sent, and none for storm_prepared', () => {
    for (const t of SENDABLE_TRANSITIONS) expect(stormMessage('en-US', t, fields).ok).toBe(true);
  });

  it('storm started: says who it is from, the hazard, the room, its temperature, until when, and what to do', () => {
    const r = stormMessage('en-US', 'storm_started', fields);
    expect(r.ok && r.value).toBe(
      `${PRODUCT_NAME} alert for Anna: a storm cut the power at home. Bedroom is at 26.4 °C and the battery keeps it safe until 7:30. No action is needed now. Next message: when the level changes or power returns.`,
    );
  });

  it('essential level and power back', () => {
    const essential = stormMessage('en-US', 'essential_level', fields);
    expect(essential.ok && essential.value).toContain('essential mode');
    expect(essential.ok && essential.value).toContain('until 7:30');
    const back = stormMessage('en-US', 'power_back', fields);
    expect(back.ok && back.value).toBe(`${PRODUCT_NAME} update for Anna: power is back at home. Bedroom is at 26.4 °C. Storm mode has ended.`);
  });

  it('the preview for the model uses the role and never the contact name or handle (property)', () => {
    const token = fc.stringMatching(/^[A-Z][a-z]{3,12}$/).map((s) => `Zq${s}`);
    fc.assert(
      fc.property(fc.constantFrom(...SENDABLE_TRANSITIONS), token, token, (transition, name, handle) => {
        const contact = { role: 'daughter', name, channel: 'in_app' as const, handle };
        const preview = stormPreview('en-US', transition, contact, { room: 'Bedroom', tempC: '26.4', safeUntil: '7:30' });
        expect(preview.ok).toBe(true);
        if (!preview.ok) return;
        expect(preview.value).toContain('daughter');
        expect(preview.value).not.toContain(name);
        expect(preview.value).not.toContain(handle);
      }),
    );
  });

  it('never gives a half-filled message', () => {
    expect(stormMessage('en-US', 'storm_started', { name: 'Anna', room: 'Bedroom', tempC: '26.4' })).toMatchObject({ ok: false, error: { missing: ['safeUntil'] } });
  });
});
