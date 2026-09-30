import { FamilyContactSchema, type FamilyContact, type StormNotification } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planNotifications } from '../src/notifications.js';

const contact = (role: string): FamilyContact => FamilyContactSchema.parse({ role, name: `Name of ${role}`, channel: 'in_app', handle: `phone-${role}` });
const contacts = [contact('daughter'), contact('son')];
const NOW = Date.parse('2026-07-17T14:00:00Z');
const sent = (role: string, transition: StormNotification['transition'], minutesAgo: number): StormNotification => ({
  at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  transition,
  contactRole: role,
  channel: 'in_app',
  delivered: true,
});

describe('planNotifications: who gets a family message (plan §13.2.4)', () => {
  it('sends to every registered contact when no role is named', () => {
    const plan = planNotifications({ contacts, transition: 'storm_started', sent: [], nowMs: NOW, minIntervalMinutes: 30 });
    expect(plan.send).toEqual(contacts);
    expect(plan.skipped).toEqual([]);
  });

  it('sends only to the named roles that are registered, and reports the others', () => {
    const plan = planNotifications({ contacts, roles: ['son', 'neighbour'], transition: 'storm_started', sent: [], nowMs: NOW, minIntervalMinutes: 30 });
    expect(plan.send).toEqual([contact('son')]);
    expect(plan.skipped).toEqual([{ role: 'neighbour', reason: 'not_registered' }]);
  });

  it('does not repeat the same transition to the same person within the interval', () => {
    const plan = planNotifications({ contacts, transition: 'storm_started', sent: [sent('daughter', 'storm_started', 10)], nowMs: NOW, minIntervalMinutes: 30 });
    expect(plan.send).toEqual([contact('son')]);
    expect(plan.skipped).toEqual([{ role: 'daughter', reason: 'rate_limited' }]);
    const later = planNotifications({ contacts, transition: 'storm_started', sent: [sent('daughter', 'storm_started', 31)], nowMs: NOW, minIntervalMinutes: 30 });
    expect(later.send).toEqual(contacts);
  });

  it('always lets "power is back" through after the other messages', () => {
    const plan = planNotifications({ contacts, transition: 'power_back', sent: [sent('daughter', 'storm_started', 1)], nowMs: NOW, minIntervalMinutes: 30 });
    expect(plan.send).toEqual(contacts);
  });

  it('never writes to anyone outside the registered contacts, whatever is asked (property, anti-exfiltration)', () => {
    fc.assert(
      fc.property(fc.option(fc.array(fc.string({ maxLength: 40 }), { maxLength: 10 }), { nil: undefined }), (roles) => {
        const plan = planNotifications({ contacts, ...(roles === undefined ? {} : { roles }), transition: 'essential_level', sent: [], nowMs: NOW, minIntervalMinutes: 30 });
        for (const target of plan.send) expect(contacts).toContain(target);
        expect(plan.send.length + plan.skipped.length).toBeLessThanOrEqual(Math.max(contacts.length, roles?.length ?? 0));
      }),
    );
  });

  it('asks each person at most once, even when a role is named twice', () => {
    const plan = planNotifications({ contacts, roles: ['son', 'son'], transition: 'storm_started', sent: [], nowMs: NOW, minIntervalMinutes: 30 });
    expect(plan.send).toEqual([contact('son')]);
  });
});
