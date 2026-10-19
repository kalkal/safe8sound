import { ok, type ErrorEnvelope, type Milestone, type Result, type ScenarioId } from '@cold-reserve/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, AskContext } from '../agent/agent.js';
import { addStops } from '../demo-controls/timeline.js';
import type { ClockNote } from '../ui/SimClock.js';
import { cutThePower, readClock, skipAhead, type ClockState } from '../ui/sim-clock.js';

export interface SimClockState {
  readonly clock: ClockState | undefined;
  readonly note: ClockNote | undefined;
  readonly busy: boolean;
  /** Every stop of the day seen since its play started, in time order (the judges' timeline). */
  readonly stops: readonly Milestone[];
  /** Skips to the next moment of the day. */
  readonly skip: () => void;
  /** "Power cut" (time pack, 12 Oct): the simulated grid goes down; the clock shows the cut. */
  readonly cutPower: (o: Omit<Parameters<typeof cutThePower>[1], 'planId'>, context: AskContext) => Promise<Result<void, ErrorEnvelope>>;
  readonly clearNote: () => void;
}

/**
 * The simulated clock (owner decision, 10 Oct; time pack, 12 Oct): for every visitor of a sandbox (or the scripted
 * home), read when the scenario, the plan on screen or the play of the day changes, and after each move; never
 * polled. After each move `afterMove` reads what follows (the home, the phone).
 */
export function useSimClock(o: {
  agent: Agent;
  enabled: boolean;
  scenario: ScenarioId | undefined;
  planId: string | undefined;
  playthrough: number;
  afterMove: () => void;
}): SimClockState {
  const { agent, enabled, scenario, planId, playthrough, afterMove } = o;
  const [clock, setClock] = useState<ClockState | undefined>(undefined);
  const [note, setNote] = useState<ClockNote | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [stops, setStops] = useState<readonly Milestone[]>([]);
  /** Shows a clock state and keeps the moments it lists for the timeline. */
  const show = useCallback((state: ClockState) => {
    setClock(state);
    // A state without its list (a move whose read after it failed) leaves the stops as they were.
    const ahead = state.upcoming;
    if (ahead !== undefined) setStops((seen) => addStops(seen, ahead, state.now));
  }, []);
  // A new scenario or a new play of the day: the timeline starts again.
  useEffect(() => {
    setStops([]);
  }, [scenario, playthrough]);
  // Each move of the clock counts: a read started before a move never draws over the clock the move left.
  const moves = useRef(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    const at = moves.current;
    void readClock(agent, planId, { correlationId: crypto.randomUUID() }).then((read) => {
      if (current && read.ok && at === moves.current) show(read.value);
    });
    return () => {
      current = false;
    };
  }, [agent, enabled, scenario, planId, playthrough, show]);
  const skip = useCallback(() => {
    if (busy) return;
    setBusy(true);
    moves.current += 1;
    void skipAhead(agent, planId, { correlationId: crypto.randomUUID() }).then((moved) => {
      setBusy(false);
      if (!moved.ok) {
        // A daily limit says so, never "Try again" (review of #378).
        setNote(moved.error.code === 'demo_quota_exceeded' ? { kind: 'limit' } : { kind: 'failed' });
        return;
      }
      moves.current += 1;
      show(moved.value.state);
      setNote({ kind: 'reached', moment: moved.value.reached.kind });
      afterMove();
    });
  }, [agent, planId, busy, afterMove, show]);
  const cutPower = useCallback(
    async (cut: Omit<Parameters<typeof cutThePower>[1], 'planId'>, context: AskContext): Promise<Result<void, ErrorEnvelope>> => {
      moves.current += 1;
      const done = await cutThePower(agent, { ...cut, planId }, context);
      if (!done.ok) return done;
      moves.current += 1;
      show(done.value.state);
      setNote(done.value.changed ? { kind: 'grid_down' } : undefined);
      afterMove();
      return ok(undefined);
    },
    [agent, planId, afterMove, show],
  );
  const clearNote = useCallback(() => {
    setNote(undefined);
  }, []);
  return { clock, note, busy, stops, skip, cutPower, clearNote };
}
