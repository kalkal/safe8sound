import { HomeStatusSchema, err, ok, toolError, type ErrorEnvelope, type HomeStatus, type Household, type Result } from '@cold-reserve/contracts';
import { homeCalm, homeInStorm } from '@cold-reserve/ui-cards';
import type { Agent, AskContext } from '../agent/agent.js';
import { withDemoHomeNames } from '../agent/script-fixtures.js';
import type { CardSlot } from '../agent/wire.js';
import { log as defaultLog, type Log } from '../log.js';

// "Show my home" (#204): the home the panel shows. A get_home_status result is shown as it is, in any mode. The
// scripted home (all fixtures already) also follows the scene: the storm, the power back, a plan applied. In remote
// mode only what the home really said is shown, never a fixture.

export type HomeMode = 'scripted' | 'remote';

export function initialHome(mode: HomeMode): HomeStatus | undefined {
  return mode === 'scripted' ? withDemoHomeNames(homeCalm()) : undefined;
}

/** The scripted home's safe room: the one chosen in Settings (bedroom-1 until the settings are read). */
const STORY_ROOM = 'bedroom-1';

/**
 * The scripted home is on the safe room chosen in Settings, the room the answers name, and its rooms are named for who is
 * at home (owner, 21 Oct): Leo's room only while he is there.
 */
export function homeFor(
  cards: readonly CardSlot[],
  previous: HomeStatus | undefined,
  mode: HomeMode,
  household: Household = 'older-man',
  safeRoomId: string = STORY_ROOM,
): HomeStatus | undefined {
  const reported = cards.find((c) => c.tool === 'get_home_status');
  if (reported?.tool === 'get_home_status') return reported.result;
  if (mode === 'remote') return previous;
  for (const card of cards) {
    if (card.tool === 'get_safe_room_status' && card.result.stormPhase === 'active') return withDemoHomeNames(homeInStorm(), household, safeRoomId);
    if (card.tool === 'plan_comfort' && 'id' in card.result && card.result.gridAvailable === false) return withDemoHomeNames(homeInStorm(), household, safeRoomId);
    if (card.tool === 'get_safe_room_status' && card.result.stormPhase === 'ended') return withDemoHomeNames(homeCalm(), household, safeRoomId);
  }
  return previous;
}

/**
 * The scripted home shown again after "Who is at home" or the safe room changes: rebuilt from its fixture (calm or in the
 * storm) on the chosen safe room and named for the household, a plan already applied kept applied.
 */
export function homeNamedFor(home: HomeStatus | undefined, mode: HomeMode, household: Household, safeRoomId: string = STORY_ROOM): HomeStatus | undefined {
  if (mode !== 'scripted' || home === undefined) return home;
  const rebuilt = withDemoHomeNames(home.gridAvailable ? homeCalm() : homeInStorm(), household, safeRoomId);
  return home.gridAvailable && wasApplied(home) ? homeAfterApply(rebuilt, mode) : rebuilt;
}

/** A calm scripted home after a plan was applied: the second bedroom pre-cooled (homeAfterApply). */
const wasApplied = (home: HomeStatus): boolean => home.rooms.some((r) => r.roomId === 'bedroom-2' && r.state === 'served') && !homeCalm().rooms.some((r) => r.roomId === 'bedroom-2' && r.state === 'served');

/** A plan applied on the scripted home pre-cools the second bedroom too; a remote home waits for its next status. */
export function homeAfterApply(previous: HomeStatus | undefined, mode: HomeMode): HomeStatus | undefined {
  if (mode === 'remote' || previous === undefined || !previous.gridAvailable) return previous;
  return {
    ...previous,
    rooms: previous.rooms.map((r) =>
      r.roomId === 'bedroom-2'
        ? { roomId: r.roomId, ...(r.name === undefined ? {} : { name: r.name }), tempC: r.tempC, ...(r.humidityPct === undefined ? {} : { humidityPct: r.humidityPct }), occupants: r.occupants, state: 'served' as const }
        : r,
    ),
  };
}

/**
 * The remote home panel reads the home on demand (#262): get_home_status through the card tool route, read-only.
 * A tool error, a result that breaks the contract or a failed call is "unreachable", logged, never a fixture.
 */
export async function fetchHome(agent: Agent, context: AskContext, logEvent: Log = defaultLog): Promise<Result<HomeStatus, ErrorEnvelope>> {
  let failure: ErrorEnvelope;
  try {
    const reply = await agent.callTool('get_home_status', {}, context);
    const status = reply.isError === true ? undefined : HomeStatusSchema.safeParse(reply.structuredContent);
    if (status?.success === true) return ok(status.data);
    failure = reply.isError === true ? toolError('agent_unavailable', 'The home could not be reached.') : toolError('output_schema_violation', 'The home sent an unexpected result.');
  } catch (error) {
    failure = toolError('agent_unavailable', 'The home could not be reached.');
    logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, error, details: { step: 'home_panel' } });
    return err(failure);
  }
  logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, details: { step: 'home_panel' } });
  return err(failure);
}
