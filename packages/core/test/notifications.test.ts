import { FamilyContactSchema, type FamilyContact, type StormNotification } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planNotifications } from '../src/notifications.js';

const contact = (role: string): FamilyContact => FamilyContactSchema.parse({ role, name: `Name of ${role}`, channel: 'in_app', handle: `phone-${role}` });
const contacts = [contact('daughter'), contact('son')];
const NOW = Date.parse('2026-07-17T14:00:00Z');
const MINUTE = 60_000;
const sentAt = (role: string, transition: StormNotification['transition'], msAgo: number, delivered = true): StormNotification => ({
  at: new Date(NOW - msAgo).toISOString(),
  transition,
  contactRole: role,
  channel: 'in_app',
  delivered,
});
const plan = (extra: Partial<Parameters<typeof planNotifications>[0]> = {}) =>
  planNotifications({ contacts, transition: 'storm_started', sent: [], nowMs: NOW, minIntervalMinutes: 30, ...extra });

describe('planNotifications: who gets a family message (plan §13.2.4)', () => {
  it('delivers to every registered contact when no role is named, and tells the model roles and channels only', () => {
    const p = plan();
    expect(p.deliveries).toEqual(contacts);
    expect(p.sent).toEqual([
      { role: 'daughter', channel: 'in_app' },
      { role: 'son', channel: 'in_app' },
    ]);
    expect(JSON.stringify(p.sent)).not.toMatch(/Name of|phone-/);
    expect(p.skipped).toEqual([]);
  });

  it('delivers only to the named roles that are registered, and reports the others', () => {
    const p = plan({ roles: ['son', 'neighbour'] });
    expect(p.deliveries).toEqual([contact('son')]);
    expect(p.skipped).toEqual([{ role: 'neighbour', reason: 'not_registered' }]);
  });

  it('does not repeat the same transition to the same person within the interval (boundaries at +-1 ms)', () => {
    const interval = 30 * MINUTE;
    expect(plan({ sent: [sentAt('daughter', 'storm_started', interval - 1)] }).skipped).toEqual([{ role: 'daughter', reason: 'rate_limited' }]);
    expect(plan({ sent: [sentAt('daughter', 'storm_started', interval)] }).deliveries).toEqual(contacts);
    expect(plan({ sent: [sentAt('daughter', 'storm_started', interval + 1)] }).deliveries).toEqual(contacts);
  });

  it('does not count a failed delivery: the person may still be told', () => {
    expect(plan({ sent: [sentAt('daughter', 'storm_started', MINUTE, false)] }).deliveries).toEqual(contacts);
  });

  it('always lets "power is back" through after the other messages', () => {
    expect(plan({ transition: 'power_back', sent: [sentAt('daughter', 'storm_started', MINUTE)] }).deliveries).toEqual(contacts);
  });

  it('never writes to anyone outside the registered contacts, whatever is asked (property, anti-exfiltration)', () => {
    const role = fc.oneof(fc.constantFrom(...contacts.map((c) => c.role)), fc.string({ maxLength: 40 }));
    fc.assert(
      fc.property(fc.option(fc.array(role, { maxLength: 10 }), { nil: undefined }), (roles) => {
        const p = plan({ ...(roles === undefined ? {} : { roles }), transition: 'essential_level' });
        for (const target of p.deliveries) expect(contacts).toContain(target);
        expect(p.sent.map((s) => s.role)).toEqual(p.deliveries.map((c) => c.role));
        for (const skipped of p.skipped) expect(contacts.map((c) => c.role)).not.toContain(skipped.role);
      }),
    );
  });

  it('asks each person at most once, even when a role is named twice', () => {
    expect(plan({ roles: ['son', 'son'] }).deliveries).toEqual([contact('son')]);
  });
});
