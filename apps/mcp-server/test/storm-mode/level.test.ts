import { STORM_SCHEMA_VERSION, StormSessionSchema, err, toolError, type StormSession } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { activeStormLevel, levelOf, runStormDetector } from '../../src/modules/storm-mode/observe.js';
import { startStormMode } from '../../src/modules/storm-mode/tools.js';
import { world } from './support.js';

// #429 (owner's decision A, 18 Oct): one level for the home status and the safe room. A storm steps the home down:
// Saver from the moment the grid goes down, Essential from the moment the home steps down to its essential settings
// (the family is told then), the person's comfort otherwise. Before, the safe room said Essential from the grid loss
// while the home status said comfort all along.

/** A storm session as the store keeps it, through its own schema (no cast: the fixture follows the contract). */
const session = (over: Record<string, unknown>): StormSession =>
  StormSessionSchema.parse({
    schemaVersion: STORM_SCHEMA_VERSION,
    id: 'storm_test00000001',
    homeId: 'demo',
    phase: 'active',
    trigger: 'grid_loss',
    startedAt: '2026-07-17T12:00:00+02:00',
    activeAt: '2026-07-17T15:00:00+02:00',
    safeRoomId: 'bedroom-1',
    occupantRoles: ['grandpa'],
    hoursAtEssential: 24,
    notifications: [],
    ...over,
  });

const told = (transition: string, at = '2026-07-17T21:00:00+02:00') => ({ at, transition, contactRole: 'daughter', channel: 'in_app', delivered: true });

describe('the level of a storm day (#429)', () => {
  it('no storm, or a storm only prepared or ended: the comfort the person chose', () => {
    expect(levelOf(undefined)).toEqual({ level: 'comfort', levelReason: 'user_choice' });
    expect(levelOf(session({ phase: 'prepare' }))).toEqual({ level: 'comfort', levelReason: 'user_choice' });
    expect(levelOf(session({ phase: 'ended', endedAt: '2026-07-18T06:40:00+02:00' }))).toEqual({ level: 'comfort', levelReason: 'user_choice' });
  });

  it('the grid down: Saver, because of the storm', () => {
    expect(levelOf(session({ notifications: [told('storm_started')] }))).toEqual({ level: 'saver', levelReason: 'storm' });
  });

  it('get_home_status reads the same level during an active storm, none outside it (activeStormLevel)', async () => {
    const calm = world(1);
    expect(await activeStormLevel(calm.deps, calm.ctx)).toBeUndefined();
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const saver = await activeStormLevel(w.deps, w.ctx);
    expect(saver).toMatchObject({ level: 'saver', levelReason: 'storm' });
    // The judges' clock reaches the essential moment: Essential, since the step itself, not since the grid loss.
    await runStormDetector(w.deps, w.ctx, 'essential');
    const stored = await w.store.getLatestStormSession();
    const essentialAt = stored.ok ? stored.value?.notifications.find((n) => n.transition === 'essential_level')?.at : undefined;
    expect(essentialAt).toBeDefined();
    expect(await activeStormLevel(w.deps, w.ctx)).toEqual({ level: 'essential', levelReason: 'storm', levelChangedAt: essentialAt });
  });

  it('a storm store that cannot be read leaves the home status its own level, with a warn line', async () => {
    const w = world(4);
    const broken = { ...w.deps, storeFor: () => ({ getLatestStormSession: () => Promise.resolve(err(toolError('store_unavailable', 'The store is down.'))) }) as never };
    expect(await activeStormLevel(broken, w.ctx)).toBeUndefined();
    expect(w.logs).toContainEqual(expect.objectContaining({ level: 'warn', message: 'storm_level_unreadable', code: 'store_unavailable', correlationId: w.ctx.correlationId }));
  });

  it('once the home stepped down to its essential settings: Essential, because of the storm', () => {
    expect(levelOf(session({ notifications: [told('storm_started'), told('essential_level')] }))).toEqual({ level: 'essential', levelReason: 'storm' });
  });
});
