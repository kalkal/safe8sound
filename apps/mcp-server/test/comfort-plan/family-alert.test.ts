import { PlanSchema, ok, type Plan } from '@cold-reserve/contracts';
import { examplePlan } from '@cold-reserve/contracts/fixtures';
import type { Notifier } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { alertFamily } from '../../src/modules/comfort-plan/family-alert.js';
import { preferences, world } from './support.js';

// #364: the last-resort alert says the room's time first only when the room then gets warmer (cooling); when heating
// the room gets colder, so the alert keeps the battery time and never says "then gets warmer" past a crossing.

const plan = (lastResort: object): Plan => PlanSchema.parse({ ...examplePlan(), guarantees: examplePlan().guarantees.map((g) => (g.id === 'safe_room_comfort' ? { ...g, ok: false } : g)), lastResort, warnings: [{ code: 'last_resort_plan', message: 'Last resort.' }] });

async function sent(p: Plan): Promise<string> {
  const texts: string[] = [];
  const notifier: Notifier = { send: (m) => { texts.push(m.text); return Promise.resolve(ok(undefined)); } };
  const w = world('storm-blackout', 4);
  const read = await w.deps.homes(w.ctx.homeId)?.source.snapshot();
  if (read?.ok !== true) throw new Error('no snapshot');
  const snapshot = read.value;
  const contacts = { ...preferences, familyContacts: [{ role: 'daughter', name: 'Giulia Example', channel: 'in_app' as const, handle: 'phone-daughter-1' }] };
  await alertFamily(notifier, { plan: p, profile: w.profile, preferences: contacts, snapshot, nowMs: Date.parse(snapshot.ts) });
  return texts[0] ?? '';
}

describe('the last-resort family alert (#364)', () => {
  const battery = { safeUntil: '2026-07-16T03:05:00+02:00', safeHours: 7.2, limitedBy: 'battery', limitCrossedAt: '2026-07-16T06:00:00+02:00', limitCrossedC: 24, worstAt: '2026-07-16T07:00:00+02:00' };

  it('cooling: the room time first, then the battery', async () => {
    expect(await sent(plan({ ...battery, comfortLimitC: 24, worstC: 26.1 }))).toContain('stays within its limits until about 6:00 AM (battery until 3:05 AM), then gets warmer.');
  });

  it('heating: the battery time only, never "then gets warmer" after a crossing under the minimum', async () => {
    const text = await sent(plan({ ...battery, comfortLimitC: 18, worstC: 16.5, limitCrossedC: 18 }));
    expect(text).not.toContain('until about');
    expect(text).toContain('until 3:05 AM');
  });
});
