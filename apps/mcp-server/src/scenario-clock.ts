import { IsoDateTimeSchema, err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { isTimeZone, localMidnightMs, scenarioClock, type Clock } from '@cold-reserve/core';
import { SCENARIO_IDS, builtInPlace, builtInScenario, type Scenario, type ScenarioId } from '@cold-reserve/source-simulator';

// The scenario clock (plan §9.4), out of app.ts (#319): how wall time maps to scenario time for every home, from the
// environment (scenario, start hour, speed, anchor). createApp and both entries build their clocks here.

const HOUR_MS = 3_600_000;
/**
 * The one scenario clock (#160): scenario time from the wall clock, the scenario, its start hour, speed and
 * anchor. createApp and the local entry use this same definition, so the simulator, the plans, the storm
 * sessions and the local store agree on "now".
 */
export function scenarioClockFor(env: Readonly<Record<string, string | undefined>>, wall: Clock): Result<Clock, ErrorEnvelope> {
  const play = scenarioPlayFor(env, wall);
  return play.ok ? ok(play.value.clock) : play;
}

/**
 * The timeline and the env scenario's clock on it, built once (C2b): an entry passes both to createApp, so the
 * sandboxes' clocks come from the same timeline as the demo's (the same start, with the default `start` anchor).
 */
export function scenarioPlayFor(env: Readonly<Record<string, string | undefined>>, wall: Clock): Result<{ timeline: ScenarioTimeline; clock: Clock }, ErrorEnvelope> {
  const start = scenarioStartFor(env);
  if (!start.ok) return start;
  const timeline = scenarioTimelineFor(env, wall);
  if (!timeline.ok) return timeline;
  // The env scenario plays in the reference place (L1, #217); a sandbox plays the place of its settings (C2b).
  const clock = timeline.value.clockFor({ startAt: start.value.scenario.startAt, tz: builtInPlace('reference').tz });
  return clock.ok ? ok({ timeline: timeline.value, clock: clock.value }) : clock;
}

/** What every home's scenario clock shares: the anchor rule, the speed and the start hour (C2a, Refs #222). */
export interface ScenarioTimeline {
  /**
   * The scenario clock of a home playing a scenario that starts at `startAt` in a place of zone `tz`. With
   * `startedAtMs`, the home's day was started again at that wall instant (a sandbox's restart, C2b): it plays from
   * the start hour then, whatever the shared anchor. With `advancedMs`, the visitor jumped that much scenario time
   * ahead (#311): it is added to the start, the anchor (the playthrough) stays.
   */
  clockFor(play: { readonly startAt: string; readonly tz: string; readonly startedAtMs?: number; readonly advancedMs?: number }): Result<Clock, ErrorEnvelope>;
}

/**
 * One timeline per process: the same anchor (MCP_SCENARIO_ANCHOR, read once at start), speed and start hour
 * for every home, so every container and every home agree on how wall time maps to scenario time; each home
 * gets the clock of its own scenario start and its own place's midnight (a Houston sandbox reads Houston time).
 */
export function scenarioTimelineFor(env: Readonly<Record<string, string | undefined>>, wall: Clock): Result<ScenarioTimeline, ErrorEnvelope> {
  const speed = envNumber(env, 'MCP_SCENARIO_SPEED', 1);
  if (!speed.ok) return speed;
  const startH = envNumber(env, 'MCP_SCENARIO_START_H', 0);
  if (!startH.ok) return startH;
  const raw = env['MCP_SCENARIO_ANCHOR'];
  const startedAtMs = wall.now();
  // Validate the anchor rule once, on the reference place, so a bad setting fails at start.
  const check = scenarioAnchor(raw, startedAtMs, builtInPlace('reference').tz);
  if (!check.ok) return check;
  return ok({
    clockFor: ({ startAt, tz, startedAtMs: restartedAtMs, advancedMs }) => {
      const anchor = restartedAtMs === undefined ? scenarioAnchor(raw, startedAtMs, tz) : ok(restartedAtMs);
      if (!anchor.ok) return anchor;
      return ok(scenarioClock({ wall, anchorMs: anchor.value, scenarioStartMs: Date.parse(startAt) + startH.value * HOUR_MS + (advancedMs ?? 0), speed: speed.value }));
    },
  });
}

/** The scenario and the instant the server starts in it (its start plus MCP_SCENARIO_START_H): one definition. */
export function scenarioStartFor(env: Readonly<Record<string, string | undefined>>): Result<{ scenario: Scenario; scenarioId: ScenarioId; startMs: number }, ErrorEnvelope> {
  const scenarioId = env['MCP_SCENARIO'] ?? 'clear-day';
  if (!(SCENARIO_IDS as readonly string[]).includes(scenarioId)) {
    return err(toolError('invalid_config', `MCP_SCENARIO must be one of ${SCENARIO_IDS.join(', ')}.`));
  }
  const startH = envNumber(env, 'MCP_SCENARIO_START_H', 0);
  if (!startH.ok) return startH;
  const scenario = builtInScenario(scenarioId as ScenarioId);
  return ok({ scenario, scenarioId: scenarioId as ScenarioId, startMs: Date.parse(scenario.startAt) + startH.value * HOUR_MS });
}

/**
 * Which wall-clock instant is the start of the scenario (R1, 2026-10-01 architecture check):
 * `start` (default) = when this server starts, fine for one local process; `daily` = midnight in the
 * IANA zone of the place (T1: right in winter and on the days the clocks change, not the fixed offset of the
 * scenario's `startAt`), so the scenario clock reads the same hour as the home and every Lambda container agrees; or a fixed ISO instant. With a fixed instant (or a speed
 * above 1) the simulator stops at the end of the scenario. With `daily` the scenario jumps back 24 h at
 * midnight: a long-running local server replays the day again from its start.
 */
export function scenarioAnchor(raw: string | undefined, startedAtMs: number, placeTimeZone: string): Result<number | ((wallMs: number) => number), ErrorEnvelope> {
  if (raw === undefined || raw === 'start') return ok(startedAtMs);
  if (raw === 'daily') {
    if (!isTimeZone(placeTimeZone)) return err(toolError('invalid_config', 'The place of the scenario has no valid IANA time zone.'));
    return ok((wallMs) => localMidnightMs(wallMs, placeTimeZone));
  }
  const instant = IsoDateTimeSchema.safeParse(raw);
  return instant.success ? ok(Date.parse(instant.data)) : err(toolError('invalid_config', 'MCP_SCENARIO_ANCHOR must be start, daily or an ISO instant.'));
}

/** A non-negative number from the environment, or its fallback when unset. */
export function envNumber(env: Readonly<Record<string, string | undefined>>, key: string, fallback: number): Result<number, ErrorEnvelope> {
  const raw = env[key];
  // Number('') is 0: an empty value is a mistake, not a request for zero.
  const value = raw === undefined ? fallback : raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? ok(value) : err(toolError('invalid_config', `${key} must be a non-negative number.`));
}
