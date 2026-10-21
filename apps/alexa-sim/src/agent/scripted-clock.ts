import { toolError, type InboxMessage, type Milestone, type MilestoneKind, type ScenarioId } from '@cold-reserve/contracts';
import { PHONE_FIXTURES, phoneMessage, type PhoneFixture } from '../phone/phone-fixtures.js';
import type { ScriptedPhone } from '../phone/phone-feed.js';
import { toolErrorResult, type ToolCallResult } from './agent.js';

// The simulated clock on the scripted home (time pack, 12 Oct): the same tools as a sandbox (set_scenario,
// get_milestones, advance_clock) over the storm night of the script, so the scripted demo and the tests walk the
// same story as the deployed site: the grid goes down, the home steps down to its essential settings, power comes back,
// and Ana's phone receives each message as the clock passes it. Other scenarios have no moments in the script.

const DAY_FROM = '2026-07-18T12:00:00+02:00';
const DAY_TO = '2026-07-19T12:00:00+02:00';

/** The storm night's moments, each with the family message the home sends then (the phone fixtures' own times). */
const STORM_NIGHT: readonly { kind: MilestoneKind; fixture: PhoneFixture; label: string }[] = [
  { kind: 'storm_start', fixture: 'storm-started', label: 'The storm starts: the grid goes down' },
  { kind: 'essential_level', fixture: 'essential', label: 'The home steps down to its essential settings' },
  { kind: 'power_back', fixture: 'power-back', label: 'Power is back (stable)' },
];

const success = (structuredContent: Record<string, unknown>, text: string): ToolCallResult => ({ content: [{ type: 'text', text }], structuredContent });

export interface ScriptedClock {
  /** Handles the clock's tools; undefined for any other tool. */
  readonly call: (name: string, args: Record<string, unknown>) => ToolCallResult | undefined;
}

export function createScriptedClock(
  o: { readonly phone?: ScriptedPhone; readonly startScenario?: ScenarioId; readonly message?: (fixture: PhoneFixture) => InboxMessage } = {},
): ScriptedClock {
  const message = o.message ?? ((fixture: PhoneFixture) => phoneMessage(fixture));
  let scenario: ScenarioId = o.startScenario ?? 'heatwave';
  /** How many of the storm night's moments are behind now. */
  let passed = 0;
  let version = 1;

  const ahead = (): Milestone[] =>
    scenario === 'storm-blackout' ? STORM_NIGHT.slice(passed).map((m) => ({ kind: m.kind, at: PHONE_FIXTURES[m.fixture].at, label: m.label })) : [];
  const now = (): string => {
    const last = passed === 0 ? undefined : STORM_NIGHT[passed - 1];
    return scenario === 'storm-blackout' && last !== undefined ? PHONE_FIXTURES[last.fixture].at : DAY_FROM;
  };

  return {
    call: (name, args) => {
      if (name === 'set_scenario') {
        const next = args['scenarioId'];
        const changed = typeof next === 'string' && next !== scenario;
        if (changed) scenario = next as ScenarioId;
        // A new play of the day: its clock from the start and an empty phone, as the server's new playthrough has.
        if (changed || args['restart'] === true) {
          passed = 0;
          o.phone?.clear();
        }
        version += 1;
        return success({ restarted: changed || args['restart'] === true }, 'Saved.');
      }
      if (name === 'get_milestones') {
        return success({ now: now(), day: { from: DAY_FROM, to: DAY_TO }, milestones: ahead() }, 'The next moments of the day.');
      }
      if (name !== 'advance_clock') return undefined;
      const index = ahead().findIndex((m) => m.kind === args['kind'] && m.at === args['at']);
      if (index < 0) return toolErrorResult(toolError('invalid_input', 'Not a moment ahead in this day: ask get_milestones again.'));
      // Every moment on the way sends its message, as the server's storm detector does at each stop.
      const crossed = STORM_NIGHT.slice(passed, passed + index + 1);
      passed += index + 1;
      version += 1;
      o.phone?.deliver(crossed.map((m) => message(m.fixture)));
      return success({ now: now(), settingsVersion: version }, `The sandbox's time is now ${now()}.`);
    },
  };
}
