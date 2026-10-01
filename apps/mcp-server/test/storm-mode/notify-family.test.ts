import { NotifyFamilyOutputSchema, err, toolError, type SendableTransition } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { notifyFamily, startStormMode } from '../../src/modules/storm-mode/tools.js';
import { preferences, stormConfig, world } from './support.js';

// notify_family (plan §4, §13.2.4): only registered contacts, text only from the templates, only for a
// transition that really happened, and at most once per transition and person within the interval.

async function activeStorm(over: Parameters<typeof world>[1] = {}) {
  const w = world(4, over);
  const started = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
  if (!started.ok) throw new Error(started.error.message);
  return w;
}

describe('notify_family', () => {
  it('sends the essential-level message to the registered contact; the model sees roles, never names', async () => {
    const w = await activeStorm();
    const out = await notifyFamily(w.deps, { transition: 'essential_level' }, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    expect(NotifyFamilyOutputSchema.parse(out.value)).toMatchObject({ sent: [{ role: 'daughter', channel: 'in_app' }], skipped: [] });
    expect(out.value.preview).toMatch(/ for daughter: /);
    expect(JSON.stringify(out.value)).not.toMatch(/Giulia|phone-daughter/);
    const [latest] = (await w.inbox());
    expect(latest).toMatchObject({ role: 'daughter', transition: 'essential_level' });
    expect(latest?.text).toMatch(/ for Giulia Example: /);
  });

  it('records the message in the session', async () => {
    const w = await activeStorm();
    await notifyFamily(w.deps, { transition: 'essential_level' }, w.ctx);
    const session = await w.store.getLatestStormSession();
    expect(session.ok && session.value?.notifications.map((n) => `${n.transition}:${n.contactRole}:${String(n.delivered)}`)).toEqual([
      'storm_started:daughter:true',
      'essential_level:daughter:true',
    ]);
  });

  it('does not repeat a transition inside the interval', async () => {
    const w = await activeStorm();
    const out = await notifyFamily(w.deps, { transition: 'storm_started' }, w.ctx);
    expect(out.ok && out.value).toMatchObject({ sent: [], skipped: [{ role: 'daughter', reason: 'rate_limited' }] });
    expect((await w.inbox())).toHaveLength(1);
    w.clock.set(w.clock.now() + (stormConfig().minIntervalMinutes + 1) * 60_000);
    const later = await notifyFamily(w.deps, { transition: 'storm_started' }, w.ctx);
    expect(later.ok && later.value.sent).toEqual([{ role: 'daughter', channel: 'in_app' }]);
  });

  it('skips a role that is not registered and still writes to the ones that are', async () => {
    const w = await activeStorm();
    const out = await notifyFamily(w.deps, { transition: 'essential_level', roles: ['daughter', 'neighbor'] }, w.ctx);
    expect(out.ok && out.value).toMatchObject({ sent: [{ role: 'daughter' }], skipped: [{ role: 'neighbor', reason: 'not_registered' }] });
  });

  it('refuses when no requested role is a registered contact', async () => {
    const w = await activeStorm();
    const out = await notifyFamily(w.deps, { transition: 'essential_level', roles: ['neighbor'] }, w.ctx);
    expect(!out.ok && out.error).toMatchObject({ code: 'recipient_not_registered', category: 'validation', details: { field: 'roles' } });
    expect((await w.inbox())).toHaveLength(1);
  });

  it('refuses when the home has no contact at all', async () => {
    const w = await activeStorm({ preferences: { ...preferences, familyContacts: [] } });
    const out = await notifyFamily(w.deps, { transition: 'essential_level' }, w.ctx);
    expect(!out.ok && out.error.code).toBe('recipient_not_registered');
  });

  it.each<[SendableTransition, number]>([
    ['storm_started', 1],
    ['essential_level', 1],
    ['power_back', 4],
  ])('refuses %s when it did not happen', async (transition, atH) => {
    const w = world(atH);
    const out = await notifyFamily(w.deps, { transition }, w.ctx);
    expect(!out.ok && out.error).toMatchObject({ code: 'invalid_input', details: { field: 'transition' } });
    expect((await w.inbox())).toEqual([]);
  });

  it('a failed delivery is an error, recorded as not delivered, and may be retried', async () => {
    let down = true;
    const phone = world(0);
    const w = await activeStorm({ notifier: { send: (m) => (down ? Promise.resolve(err(toolError('store_unavailable', 'The phone is down.'))) : phone.deps.notifier.send(m)) } });
    const failed = await notifyFamily(w.deps, { transition: 'essential_level' }, w.ctx);
    expect(!failed.ok && failed.error.code).toBe('store_unavailable');
    const session = await w.store.getLatestStormSession();
    expect(session.ok && session.value?.notifications.at(-1)).toMatchObject({ transition: 'essential_level', delivered: false });
    down = false;
    const retry = await notifyFamily(w.deps, { transition: 'essential_level' }, w.ctx);
    expect(retry.ok && retry.value.sent).toHaveLength(1);
    expect((await phone.inbox()).map((m) => m.transition)).toEqual(['essential_level']);
  });

  it('property: whatever roles the model asks for, only registered contacts get a message, and no name reaches the model', async () => {
    const role = fc.stringMatching(/^[a-z][a-z_-]{0,31}$/);
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.oneof(role, fc.constant('daughter'), fc.constant('son')), { minLength: 1, maxLength: 3 }), async (roles) => {
        const contacts = [...preferences.familyContacts, { role: 'son', name: 'Marco Example', channel: 'in_app' as const, handle: 'phone-son-1' }];
        const w = await activeStorm({ preferences: { ...preferences, familyContacts: contacts } });
        const before = (await w.inbox()).length;
        const out = await notifyFamily(w.deps, { transition: 'essential_level', roles }, w.ctx);
        const registered = new Set(contacts.map((c) => c.role));
        const delivered = (await w.inbox()).slice(0, (await w.inbox()).length - before);
        expect(delivered.every((m) => registered.has(m.role) && roles.includes(m.role))).toBe(true);
        expect(delivered).toHaveLength(roles.filter((r) => registered.has(r)).length);
        const seen = JSON.stringify(out.ok ? out.value : out.error);
        expect(seen).not.toMatch(/Example|phone-/);
        return true;
      }),
      { numRuns: 40 },
    );
  });

});
