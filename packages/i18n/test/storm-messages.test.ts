import { SENDABLE_TRANSITIONS } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME, stormMessage, stormPreview } from '../src/index.js';

// 2026-07-17 in Rome is CEST (UTC+2).
const fields = {
  roomName: 'Bedroom',
  tempC: 26.44,
  atMs: Date.parse('2026-07-18T04:40:00Z'),
  powerBackAtMs: Date.parse('2026-07-18T04:30:00Z'),
  safeUntilMs: Date.parse('2026-07-18T05:30:00Z'),
  timeZone: 'Europe/Rome',
};

describe('storm family messages (Mileti: source, hazard, place, status, time, what to do)', () => {
  it('has a template for every transition that is sent', () => {
    for (const t of SENDABLE_TRANSITIONS) expect(stormMessage('en-US', t, 'Anna', fields).ok).toBe(true);
  });

  it('storm started: who it is from, the hazard, the room, its temperature (one decimal), until when (home time), what to do', () => {
    const r = stormMessage('en-US', 'storm_started', 'Anna', fields);
    expect(r.ok && r.value).toBe(
      `${PRODUCT_NAME} alert for Anna: a storm cut the power at home. Bedroom is at 26.4 °C and the battery keeps it safe until 7:30 AM. No action is needed now. Next message: when the level changes or power returns.`,
    );
  });

  it('essential level says until when', () => {
    const r = stormMessage('en-US', 'essential_level', 'Anna', fields);
    expect(r.ok && r.value).toContain('essential mode');
    expect(r.ok && r.value).toContain('until 7:30 AM');
  });

  it('power back says when the grid came back (not when the message is sent), and that no action is needed', () => {
    const r = stormMessage('en-US', 'power_back', 'Anna', fields);
    expect(r.ok && r.value).toBe(`${PRODUCT_NAME} update for Anna: power came back at home at 6:30 AM. Bedroom is at 26.4 °C. Storm mode has ended. No action is needed.`);
  });

  it('last resort applied: battery low, check on them, with until when the room is safe (#160)', () => {
    const r = stormMessage('en-US', 'last_resort_applied', 'Anna', fields);
    expect(r.ok && r.value).toBe(
      `${PRODUCT_NAME} alert for Anna: the home battery is low. Bedroom is at 26.4 °C and stays within its limits until 7:30 AM, then gets warmer. Please check on them.`,
    );
    const noUntil = { roomName: fields.roomName, tempC: fields.tempC, atMs: fields.atMs, timeZone: fields.timeZone };
    expect(stormMessage('en-US', 'last_resort_applied', 'Anna', noUntil)).toMatchObject({ ok: false, error: { missing: ['safeUntil'] } });
  });

  it('needs the safe-until time for the messages that quote it', () => {
    const noUntil = { roomName: fields.roomName, tempC: fields.tempC, atMs: fields.atMs, powerBackAtMs: fields.powerBackAtMs, timeZone: fields.timeZone };
    expect(stormMessage('en-US', 'storm_started', 'Anna', noUntil)).toMatchObject({ ok: false, error: { missing: ['safeUntil'] } });
    expect(stormMessage('en-US', 'power_back', 'Anna', noUntil).ok).toBe(true);
    const noBack = { roomName: fields.roomName, tempC: fields.tempC, atMs: fields.atMs, timeZone: fields.timeZone };
    expect(stormMessage('en-US', 'power_back', 'Anna', noBack)).toMatchObject({ ok: false, error: { missing: ['powerBackAt'] } });
  });

  it('the preview for the model uses the role and never the contact name or handle (property)', () => {
    const token = fc.stringMatching(/^[A-Z][a-z]{3,12}$/).map((s) => `Zq${s}`);
    fc.assert(
      fc.property(fc.constantFrom(...SENDABLE_TRANSITIONS), token, token, (transition, name, handle) => {
        const contact = { role: 'daughter', name, channel: 'in_app' as const, handle };
        const preview = stormPreview('en-US', transition, contact, fields);
        expect(preview.ok).toBe(true);
        if (!preview.ok) return;
        expect(preview.value).toContain('daughter');
        expect(preview.value).not.toContain(name);
        expect(preview.value).not.toContain(handle);
      }),
    );
  });
});
