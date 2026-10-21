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
    for (const t of SENDABLE_TRANSITIONS) expect(stormMessage('en-US', t, 'Ana', fields).ok).toBe(true);
  });

  it('storm started: who it is from, the hazard, the room, its temperature (one decimal), until when (home time), what to do', () => {
    const r = stormMessage('en-US', 'storm_started', 'Ana', fields);
    expect(r.ok && r.value).toBe(
      `${PRODUCT_NAME} alert for Ana: a storm cut the power at home. Bedroom is at 26.4 °C and the battery keeps it safe until 07:30. No action is needed now. Next message: when the level changes or power returns.`,
    );
  });

  it('in the unit the sandbox chose: 26.44 °C is 79.6 °F, in English and Italian (#306)', () => {
    const f = { ...fields, unit: 'F' as const };
    const r = stormMessage('en-US', 'power_back', 'Ana', f);
    expect(r.ok && r.value).toBe(`${PRODUCT_NAME} update for Ana: power came back at home at 06:30. Bedroom is at 79.6 °F. Storm mode has ended. No action is needed now.`);
    const it = stormMessage('it-IT', 'power_back', 'Ana', f);
    expect(it.ok && it.value).toContain('Bedroom è a 79.6 °F.');
    for (const t of SENDABLE_TRANSITIONS) expect(JSON.stringify(stormMessage('en-US', t, 'Ana', f))).not.toContain('°C');
  });

  it('essential level says until when', () => {
    const r = stormMessage('en-US', 'essential_level', 'Ana', fields);
    expect(r.ok && r.value).toContain('the home stepped down to its essential settings to keep Bedroom safe longer, until 07:30.');
    expect(r.ok && r.value).toContain('until 07:30');
  });

  it('power back says when the grid came back (not when the message is sent), and that no action is needed (below its limit)', () => {
    const r = stormMessage('en-US', 'power_back', 'Ana', fields);
    expect(r.ok && r.value).toBe(`${PRODUCT_NAME} update for Ana: power came back at home at 06:30. Bedroom is at 26.4 °C. Storm mode has ended. No action is needed now.`);
  });

  it('last resort applied: battery low, check on them, with until when the room is safe (#160)', () => {
    const r = stormMessage('en-US', 'last_resort_applied', 'Ana', fields);
    expect(r.ok && r.value).toBe(
      `${PRODUCT_NAME} alert for Ana: the home battery is low. Bedroom is at 26.4 °C and stays within its limits until 07:30, then gets warmer. Please check on them.`,
    );
    const noUntil = { roomName: fields.roomName, tempC: fields.tempC, atMs: fields.atMs, timeZone: fields.timeZone };
    expect(stormMessage('en-US', 'last_resort_applied', 'Ana', noUntil)).toMatchObject({ ok: false, error: { missing: ['safeUntil'] } });
  });

  it('#364: when the battery ends first, the time the room stays within its limits leads and the battery time follows', () => {
    const within = { ...fields, withinLimitsUntilMs: Date.parse('2026-07-18T08:00:00Z') };
    const lr = stormMessage('en-US', 'last_resort_applied', 'Ana', within);
    expect(lr.ok && lr.value).toBe(
      `${PRODUCT_NAME} alert for Ana: the home battery is low. Bedroom is at 26.4 °C and stays within its limits until about 10:00 (battery until 07:30), then gets warmer. Please check on them.`,
    );
    const started = stormMessage('en-US', 'storm_started', 'Ana', within);
    expect(started.ok && started.value).toBe(
      `${PRODUCT_NAME} alert for Ana: a storm cut the power at home. Bedroom is at 26.4 °C and stays within its limits until about 10:00 (battery until 07:30), then gets warmer. No action is needed now. Next message: when the level changes or power returns.`,
    );
    const essential = stormMessage('en-US', 'essential_level', 'Ana', within);
    expect(essential.ok && essential.value).toContain('the home stepped down to its essential settings to keep Bedroom safe longer. Bedroom is at 26.4 °C and stays within its limits until about 10:00 (battery until 07:30)');
    const it = stormMessage('it-IT', 'last_resort_applied', 'Ana', within);
    expect(it.ok && it.value).toContain('resta nei suoi limiti fino alle 10:00 circa (batteria fino alle 07:30), poi si scalda');
    // Power back quotes neither time.
    expect(stormMessage('en-US', 'power_back', 'Ana', within)).toEqual(stormMessage('en-US', 'power_back', 'Ana', fields));
  });

  it('needs the safe-until time for the messages that quote it', () => {
    const noUntil = { roomName: fields.roomName, tempC: fields.tempC, atMs: fields.atMs, powerBackAtMs: fields.powerBackAtMs, timeZone: fields.timeZone };
    expect(stormMessage('en-US', 'storm_started', 'Ana', noUntil)).toMatchObject({ ok: false, error: { missing: ['untilSafe'] } });
    expect(stormMessage('en-US', 'power_back', 'Ana', noUntil).ok).toBe(true);
    const noBack = { roomName: fields.roomName, tempC: fields.tempC, atMs: fields.atMs, timeZone: fields.timeZone };
    expect(stormMessage('en-US', 'power_back', 'Ana', noBack)).toMatchObject({ ok: false, error: { missing: ['powerBackAt'] } });
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

  it('#390: above its limit as said, the room is never told "no action": the family is asked to check, with the limit', () => {
    const hot = { ...fields, tempC: 26.96, limitC: 26 };
    const back = stormMessage('en-US', 'power_back', 'Ana', hot);
    expect(back.ok && back.value).toBe(`${PRODUCT_NAME} update for Ana: power came back at home at 06:30. Bedroom is at 27.0 °C. Storm mode has ended. Bedroom is above its 26 °C limit: please check on them.`);
    for (const t of SENDABLE_TRANSITIONS) {
      const r = stormMessage('en-US', t, 'Ana', hot);
      expect(r.ok && r.value).not.toContain('No action');
    }
    // At the limit as said (26.04 reads 26.0) there is nothing to check; in °F the limit is said in °F.
    expect(JSON.stringify(stormMessage('en-US', 'power_back', 'Ana', { ...fields, tempC: 26.04, limitC: 26 }))).toContain('No action is needed now.');
    const f = stormMessage('en-US', 'storm_started', 'Ana', { ...hot, unit: 'F' as const });
    expect(f.ok && f.value).toContain('Bedroom is above its 78.8 °F limit: please check on them.');
    const it = stormMessage('it-IT', 'power_back', 'Ana', hot);
    expect(it.ok && it.value).toContain('Bedroom è sopra il suo limite di 26 °C: per favore, vai a controllare.');
  });

  it('#390: a time on a later day than the message says so: at the 24-hour cap it never reads as the time it is sent', () => {
    const atMs = Date.parse('2026-07-17T13:00:00Z'); // 15:00 in Rome
    const capped = { ...fields, atMs, safeUntilMs: atMs + 24 * 3_600_000, safeUntilCapped: true };
    const r = stormMessage('en-US', 'storm_started', 'Ana', capped);
    expect(r.ok && r.value).toContain('keeps it safe at least until 15:00 tomorrow.');
    // Past midnight the same evening counts as tomorrow too; the same day never does.
    const night = stormMessage('en-US', 'essential_level', 'Ana', { ...capped, safeUntilCapped: false, safeUntilMs: Date.parse('2026-07-17T23:10:00Z') });
    expect(night.ok && night.value).toContain('safe longer, until 01:10 tomorrow.');
    const sameDay = stormMessage('en-US', 'essential_level', 'Ana', { ...capped, safeUntilCapped: false, safeUntilMs: Date.parse('2026-07-17T19:00:00Z') });
    expect(sameDay.ok && sameDay.value).toContain('safe longer, until 21:00.');
    const within = stormMessage('en-US', 'storm_started', 'Ana', { ...capped, safeUntilMs: Date.parse('2026-07-17T20:00:00Z'), withinLimitsUntilMs: atMs + 24 * 3_600_000 });
    expect(within.ok && within.value).toContain('until about 15:00 tomorrow (battery until 22:00)');
    const it = stormMessage('it-IT', 'storm_started', 'Ana', capped);
    expect(it.ok && it.value).toContain('almeno fino alle 15:00 di domani.');
  });

  it('21 Oct: a preparation the person asked for with no storm in the forecast says so, never that a storm is expected', () => {
    const atMs = Date.parse('2026-07-17T10:00:00Z');
    const r = stormMessage('en-US', 'storm_prepared', 'Ana', { ...fields, atMs, safeUntilMs: atMs + 24 * 3_600_000, safeUntilCapped: true, preparedAtRequest: true });
    expect(r.ok && r.value).toContain('the home is ready for a power cut, prepared at the request of the person at home (the forecast shows no storm).');
    expect(r.ok && r.value).not.toMatch(/storm is expected/i);
    const within = stormMessage('en-US', 'storm_prepared', 'Ana', { ...fields, atMs, safeUntilMs: atMs + 3 * 3_600_000, withinLimitsUntilMs: atMs + 5 * 3_600_000, preparedAtRequest: true });
    expect(within.ok && within.value).toContain('prepared at the request of the person at home');
    expect(within.ok && within.value).toContain('stays within its limits until about');
    const it = stormMessage('it-IT', 'storm_prepared', 'Ana', { ...fields, atMs, safeUntilMs: atMs + 24 * 3_600_000, safeUntilCapped: true, preparedAtRequest: true });
    expect(it.ok && it.value).toContain('preparata su richiesta di chi è in casa (le previsioni non danno temporali)');
    // The other transitions never change with the flag.
    const plain = stormMessage('en-US', 'storm_started', 'Ana', { ...fields, atMs, safeUntilMs: atMs + 3_600_000 });
    const flagged = stormMessage('en-US', 'storm_started', 'Ana', { ...fields, atMs, safeUntilMs: atMs + 3_600_000, preparedAtRequest: true });
    expect(flagged).toEqual(plain);
  });

  it('#390: a storm expected and the home prepared: the hazard ahead, the room, what the battery would do if the power goes out', () => {
    const atMs = Date.parse('2026-07-17T10:00:00Z'); // noon in Rome
    const r = stormMessage('en-US', 'storm_prepared', 'Ana', { ...fields, atMs, safeUntilMs: atMs + 24 * 3_600_000, safeUntilCapped: true });
    expect(r.ok && r.value).toBe(
      `${PRODUCT_NAME} notice for Ana: a storm is expected and the home is ready for a power cut. Bedroom is at 26.4 °C; if the power goes out, the battery keeps it safe at least until 12:00 tomorrow. No action is needed now. Next message: if the power goes out.`,
    );
  });
});
