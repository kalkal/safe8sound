import { ok, type ErrorEnvelope, type Result, type ScenarioId } from '@cold-reserve/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, AskContext } from '../agent/agent.js';
import type { ClockNote } from '../ui/SimClock.js';
import { cutThePower, readClock, skipAhead, type ClockState } from '../ui/sim-clock.js';

export interface SimClockState {
  readonly clock: ClockState | undefined;
  readonly note: ClockNote | undefined;
  readonly busy: boolean;
  /** Skips to the next moment of the day. */
  readonly skip: () => void;
  /** "Power cut" (time pack, 12 Oct): the simulated grid goes down; the clock shows the cut. */
  readonly cutPower: (o: Parameters<typeof cutThePower>[1], context: AskContext) => Promise<Result<void, ErrorEnvelope>>;
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
  // Each move of the clock counts: a read started before a move never draws over the clock the move left.
  const moves = useRef(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    const at = moves.current;
    void readClock(agent, planId, { correlationId: crypto.randomUUID() }).then((read) => {
      if (current && read.ok && at === moves.current) setClock(read.value);
    });
    return () => {
      current = false;
    };
  }, [agent, enabled, scenario, planId, playthrough]);
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
      setClock(moved.value.state);
      setNote({ kind: 'reached', moment: moved.value.reached.kind });
      afterMove();
    });
  }, [agent, planId, busy, afterMove]);
  const cutPower = useCallback(
    async (cut: Parameters<typeof cutThePower>[1], context: AskContext): Promise<Result<void, ErrorEnvelope>> => {
      moves.current += 1;
      const done = await cutThePower(agent, cut, context);
      if (!done.ok) return done;
      moves.current += 1;
      setClock(done.value.state);
      setNote(done.value.changed ? { kind: 'grid_down' } : undefined);
      afterMove();
      return ok(undefined);
    },
    [agent, afterMove],
  );
  const clearNote = useCallback(() => {
    setNote(undefined);
  }, []);
  return { clock, note, busy, skip, cutPower, clearNote };
}
