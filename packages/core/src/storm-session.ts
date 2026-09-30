import { STORM_SCHEMA_VERSION, epochMs, type HomeId, type Level, type StormId, type StormSession, type StormTransition } from '@cold-reserve/contracts';
import { effectiveStormMode, type StormMode } from './storm.js';

// The storm session as a pure state machine (plan §9.2): the deterministic transition detector runs
// it on every reading, request and tick, without the LLM. At most one transition per event, so each
// transition produces exactly one announcement or message.

export type StormEvent =
  | { readonly type: 'request'; readonly mode: StormMode; readonly trigger: 'user' | 'forecast' | 'scenario'; readonly at: string; readonly gridAvailable: boolean }
  | { readonly type: 'reading'; readonly at: string; readonly gridAvailable: boolean; readonly level: Level; readonly previousLevel: Level }
  | { readonly type: 'cancel'; readonly at: string };

export interface StormContext {
  readonly homeId: HomeId;
  readonly newId: () => StormId;
  readonly safeRoomId: string;
  readonly occupantRoles: readonly string[];
  readonly hoursAtEssential: number;
  /** Preferences: the person allowed the storm to start by itself on a measured grid loss. */
  readonly autoStormOnGridLoss: boolean;
  /** Minutes of stable grid before the storm ends (plan: 10, from config). */
  readonly stableGridMinutes: number;
  readonly scenario?: string;
}

export interface StormStep {
  readonly session: StormSession | undefined;
  readonly transitions: readonly StormTransition[];
}

const same = (session: StormSession | undefined): StormStep => ({ session, transitions: [] });

function open(ctx: StormContext, at: string, trigger: StormSession['trigger'], active: boolean): StormSession {
  return {
    schemaVersion: STORM_SCHEMA_VERSION,
    id: ctx.newId(),
    homeId: ctx.homeId,
    phase: active ? 'active' : 'prepare',
    trigger,
    startedAt: at,
    ...(active ? { activeAt: at } : {}),
    safeRoomId: ctx.safeRoomId,
    occupantRoles: [...ctx.occupantRoles],
    hoursAtEssential: ctx.hoursAtEssential,
    ...(ctx.scenario === undefined ? {} : { scenario: ctx.scenario }),
    notifications: [],
  };
}

/** Removes `gridBackAt`: the stable-grid window starts again. */
function withoutGridBack(session: StormSession): StormSession {
  const copy = { ...session };
  delete copy.gridBackAt;
  return copy;
}

export function stormReduce(previous: StormSession | undefined, event: StormEvent, ctx: StormContext): StormStep {
  const session = previous?.phase === 'ended' ? undefined : previous;

  if (event.type === 'cancel') {
    // Only a storm that is still being prepared can be called off; an active one ends with the grid.
    if (session?.phase !== 'prepare') return same(previous);
    return { session: { ...session, phase: 'ended', endedAt: event.at }, transitions: [] };
  }

  if (event.type === 'request') {
    const { mode } = effectiveStormMode(event.mode, event.gridAvailable);
    if (!session) {
      const opened = open(ctx, event.at, mode === 'active' ? 'grid_loss' : event.trigger, mode === 'active');
      return { session: opened, transitions: [mode === 'active' ? 'storm_started' : 'storm_prepared'] };
    }
    if (session.phase === 'prepare' && mode === 'active') {
      return { session: { ...session, phase: 'active', activeAt: event.at }, transitions: ['storm_started'] };
    }
    return same(previous);
  }

  // A reading: the grid state is measured, the level comes from the pacing.
  if (!session) {
    if (event.gridAvailable || !ctx.autoStormOnGridLoss) return same(previous);
    return { session: open(ctx, event.at, 'grid_loss', true), transitions: ['storm_started'] };
  }

  if (session.phase === 'prepare') {
    if (event.gridAvailable) return same(previous);
    return { session: { ...session, phase: 'active', activeAt: event.at }, transitions: ['storm_started'] };
  }

  // Active.
  if (!event.gridAvailable) {
    const current = session.gridBackAt === undefined ? session : withoutGridBack(session);
    const essentialReached = event.level === 'essential' && event.previousLevel !== 'essential';
    return { session: current, transitions: essentialReached ? ['essential_level'] : [] };
  }
  if (session.gridBackAt === undefined) return { session: { ...session, gridBackAt: event.at }, transitions: [] };
  if (epochMs(event.at) - epochMs(session.gridBackAt) < ctx.stableGridMinutes * 60_000) return same(previous);
  return { session: { ...session, phase: 'ended', endedAt: event.at }, transitions: ['power_back'] };
}
