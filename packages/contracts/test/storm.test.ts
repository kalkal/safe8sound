import { describe, expect, it } from 'vitest';
import {
  NotifyFamilyInputSchema,
  NotifyFamilyOutputSchema,
  SENDABLE_TRANSITIONS,
  SafeRoomStatusSchema,
  StartStormModeInputSchema,
  StartStormModeOutputSchema,
  StormSessionSchema,
  categoryOf,
} from '../src/index.js';

// Contracts of F6 (issue #23), approved in #23.

const session = {
  schemaVersion: 1,
  id: 'storm_7Hq2mX9vK3',
  homeId: 'demo',
  phase: 'active',
  trigger: 'grid_loss',
  startedAt: '2026-07-17T13:00:00Z',
  activeAt: '2026-07-17T13:00:00Z',
  safeRoomId: 'bedroom-1',
  occupantRoles: ['grandpa'],
  hoursAtEssential: 18.5,
  scenario: 'storm-blackout',
  notifications: [{ at: '2026-07-17T13:00:00Z', transition: 'storm_started', contactRole: 'daughter', channel: 'in_app', delivered: true }],
};

describe('StormSessionSchema', () => {
  it('parses an active storm session', () => {
    expect(StormSessionSchema.safeParse(session).success).toBe(true);
  });

  it('requires activeAt while active, whatever the trigger', () => {
    const noActiveAt = { ...session, activeAt: undefined };
    expect(StormSessionSchema.safeParse(noActiveAt).success).toBe(false);
    expect(StormSessionSchema.safeParse({ ...noActiveAt, trigger: 'user' }).success).toBe(false);
  });

  it('allows a storm that ends while still in prepare, without activeAt', () => {
    const ended = { ...session, activeAt: undefined, phase: 'ended', trigger: 'user', endedAt: '2026-07-17T15:00:00Z', notifications: [] };
    expect(StormSessionSchema.safeParse(ended).success).toBe(true);
  });

  it('requires endedAt exactly when the phase is ended', () => {
    expect(StormSessionSchema.safeParse({ ...session, endedAt: '2026-07-18T06:40:00Z' }).success).toBe(false);
    expect(StormSessionSchema.safeParse({ ...session, phase: 'ended' }).success).toBe(false);
  });

  it('keeps the times in order', () => {
    expect(StormSessionSchema.safeParse({ ...session, activeAt: '2026-07-17T12:00:00Z' }).success).toBe(false);
    expect(StormSessionSchema.safeParse({ ...session, phase: 'ended', gridBackAt: '2026-07-18T06:30:00Z', endedAt: '2026-07-18T06:20:00Z' }).success).toBe(
      false,
    );
  });

  it('records notifications by role and channel only: names and handles are refused', () => {
    const [n] = session.notifications;
    expect(StormSessionSchema.safeParse({ ...session, notifications: [{ ...n, name: 'Anna' }] }).success).toBe(false);
    expect(StormSessionSchema.safeParse({ ...session, notifications: [{ ...n, handle: '+39 333' }] }).success).toBe(false);
  });
});

describe('storm tool contracts', () => {
  it('start_storm_mode takes only the mode', () => {
    expect(StartStormModeInputSchema.safeParse({ mode: 'prepare' }).success).toBe(true);
    expect(StartStormModeInputSchema.safeParse({ mode: 'active', unlockReserve: true }).success).toBe(false);
  });

  it('start_storm_mode says the effective mode and whether the reserve is unlocked', () => {
    const out = { session, effectiveMode: 'prepare', reserveUnlocked: false, reason: 'grid_still_up', safeHours: 18.5, safeUntil: '2026-07-18T07:30:00Z' };
    expect(StartStormModeOutputSchema.safeParse({ ...out, session: { ...session, phase: 'prepare', activeAt: undefined } }).success).toBe(true);
    expect(StartStormModeOutputSchema.safeParse({ ...out, safeHours: -1 }).success).toBe(false);
  });

  it('get_safe_room_status reports roles, level and reason, and the data origin', () => {
    const status = {
      safeRoomId: 'bedroom-1',
      tempC: 26.4,
      humidityPct: 55,
      occupantRoles: ['grandpa'],
      level: 'saver',
      levelReason: 'storm',
      safeHours: 9.5,
      safeUntil: '2026-07-18T00:30:00Z',
      stormPhase: 'active',
      origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'storm-blackout' },
      homeLink: 'ok',
    };
    expect(SafeRoomStatusSchema.safeParse(status).success).toBe(true);
    expect(SafeRoomStatusSchema.safeParse({ ...status, occupantRoles: ['Grandpa Joe'] }).success).toBe(false);
  });

  it('notify_family accepts no free text, recipient or handle (anti-exfiltration)', () => {
    expect(NotifyFamilyInputSchema.safeParse({ transition: 'storm_started' }).success).toBe(true);
    expect(NotifyFamilyInputSchema.safeParse({ transition: 'power_back', roles: ['daughter'] }).success).toBe(true);
    for (const extra of [{ text: 'hi' }, { recipient: 'a@b.c' }, { handle: '+1 555' }, { phone: '555' }]) {
      expect(NotifyFamilyInputSchema.safeParse({ transition: 'storm_started', ...extra }).success).toBe(false);
    }
  });

  it('notify_family sends only on the transitions that are worth a message', () => {
    expect(SENDABLE_TRANSITIONS).toEqual(['storm_started', 'essential_level', 'power_back']);
    expect(NotifyFamilyInputSchema.safeParse({ transition: 'storm_prepared' }).success).toBe(false);
  });

  it('notify_family answers with roles and a preview, never names', () => {
    const out = { sent: [{ role: 'daughter', channel: 'in_app' }], skipped: [{ role: 'neighbour', reason: 'not_registered' }], preview: 'Storm: …' };
    expect(NotifyFamilyOutputSchema.safeParse(out).success).toBe(true);
    expect(NotifyFamilyOutputSchema.safeParse({ ...out, sent: [{ role: 'daughter', channel: 'in_app', name: 'Anna' }] }).success).toBe(false);
  });

  it('has an error code for a request naming only unregistered roles', () => {
    expect(categoryOf('recipient_not_registered')).toBe('validation');
  });
});
