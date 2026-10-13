import { describe, expect, it, vi } from 'vitest';
import type { Agent, ToolCallResult } from '../../src/agent/agent.js';
import { createScriptedClock } from '../../src/agent/scripted-clock.js';
import type { CardSlot } from '../../src/agent/wire.js';
import type { LogEvent } from '../../src/log.js';
import { createScriptedPhone } from '../../src/phone/phone-feed.js';
import { clockTime, cutThePower, isPowerCut, planIdOf, readClock, skipAhead } from '../../src/ui/sim-clock.js';

// The simulated clock (owner decision, 10 Oct; time pack, 12 Oct): the page's side of get_milestones / advance_clock /
// set_scenario. The sandbox's rules (never backwards, the family told once) are the server's and tested there (#317);
// here the wiring: which moment is chosen, the plan passed, the power cut, and every failure as a logged value.

const ctx = { correlationId: 'c-clock' };
const PLAN = 'plan-0123456789';

/** An agent whose tool calls the scripted clock answers (the sandbox's tools, the storm night of the script). */
function sandbox(start: 'heatwave' | 'storm-blackout' = 'heatwave') {
  const phone = createScriptedPhone();
  const clock = createScriptedClock({ phone, startScenario: start });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const agent = {
    canCallTools: true,
    ask: () => Promise.reject(new Error('unused')),
    callTool: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve(clock.call(name, args) ?? { isError: true, content: [{ type: 'text', text: 'no' }] });
    },
  } satisfies Agent;
  const saveStorm = vi.fn(async (change: Record<string, unknown>) => {
    await agent.callTool('set_scenario', change);
    return true;
  });
  return { agent, calls, phone, saveStorm };
}

/** An agent whose every call gets `reply` (or throws it). */
const answering = (reply: ToolCallResult | Error): Agent => ({
  canCallTools: true,
  ask: () => Promise.reject(new Error('unused')),
  callTool: () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)),
});
const refused = (code: string): ToolCallResult => ({ isError: true, content: [{ type: 'text', text: 'Refused.' }], structuredContent: { code, message: 'Refused.' } });

describe('isPowerCut', () => {
  it('hears that the power is out now, said, typed or tapped, in English and Italian', () => {
    for (const said of [
      "The power's out",
      'the power is out',
      'The power just went out.',
      'Power cut',
      'Power cut!',
      'We have a blackout',
      "There's a power outage at home",
      'we lost power',
      'The grid is down',
      'the power’s out',
      'È saltata la corrente',
      'è andata via la luce',
      'Manca la corrente',
      'siamo senza luce',
      "C'è un blackout",
      'Blackout',
      'La corrente è saltata',
      'la luce è andata via',
    ]) {
      expect(isPowerCut(said), said).toBe(true);
    }
  });

  it('never a question, a hypothetical, a plan for later or the power coming back (review of #378)', () => {
    for (const said of [
      'Is the power back?',
      'The power is back',
      'Is the power out?',
      'È tornata la corrente?',
      "What's my battery level?",
      'How long will the cold reserve last?',
      'powerful fan',
      'How long can we last in a power cut?',
      'Will there be a blackout tonight?',
      'Prepare the house for a power cut',
      'What if the power goes out?',
      'If the power is out, keep Grandpa cool',
      'A power cut tomorrow would be bad',
      'Se manca la corrente cosa faccio?',
      "C'è un blackout?",
      'È saltata la corrente?',
      'Domani manca la corrente',
      'Prepara la casa per un blackout',
      'Quanto dura un blackout',
      'Turn the power off in the kitchen',
      'La corrente è tornata',
    ]) {
      expect(isPowerCut(said), said).toBe(false);
    }
  });
});

describe('clockTime and planIdOf', () => {
  it('reads the home’s own hour from a local ISO time, whatever the viewer’s zone', () => {
    expect(clockTime('2026-07-18T19:42:00+02:00')).toBe('19:42');
    expect(clockTime('not a time')).toBe('');
  });

  it('the last plan among the cards; none without a plan or with a refusal', () => {
    const plan = (id: string) => ({ tool: 'plan_comfort', result: { id } }) as unknown as CardSlot;
    expect(planIdOf([plan('p-aaaaaaaa'), { tool: 'invalid' }, plan(PLAN)])).toBe(PLAN);
    expect(planIdOf([{ tool: 'invalid' }])).toBeUndefined();
    expect(planIdOf([{ tool: 'plan_comfort', result: { code: 'guard_refused' } } as unknown as CardSlot])).toBeUndefined();
    expect(planIdOf(undefined)).toBeUndefined();
  });
});

describe('readClock and skipAhead', () => {
  it('reads the time and the next moment; skipping goes to that moment and the phone gets its message', async () => {
    const { agent, phone } = sandbox('storm-blackout');
    const read = await readClock(agent, undefined, ctx, () => undefined);
    expect(read).toMatchObject({ ok: true, value: { now: '2026-07-18T12:00:00+02:00', next: { kind: 'storm_start' } } });

    const lines: LogEvent[] = [];
    const moved = await skipAhead(agent, undefined, ctx, (e) => lines.push(e));
    expect(moved).toMatchObject({ ok: true, value: { reached: { kind: 'storm_start' }, state: { now: '2026-07-18T19:42:00+02:00', next: { kind: 'essential_level' } } } });
    expect(phone.messages().map((m) => m.transition)).toEqual(['storm_started']);
    expect(lines).toEqual([{ level: 'info', code: 'clock_skipped', correlationId: 'c-clock', details: { kind: 'storm_start' } }]);
  });

  it('passes the plan on screen, so its own moments are listed and crossed', async () => {
    const { agent, calls } = sandbox('storm-blackout');
    await skipAhead(agent, PLAN, ctx, () => undefined);
    expect(calls.map((c) => [c.name, c.args['planId']])).toEqual([
      ['get_milestones', PLAN],
      ['advance_clock', PLAN],
      ['get_milestones', PLAN],
    ]);
  });

  it('a plan the sandbox no longer knows is left out, not a failure', async () => {
    const seen: Record<string, unknown>[] = [];
    const agent: Agent = {
      canCallTools: true,
      ask: () => Promise.reject(new Error('unused')),
      callTool: (_name, args) => {
        seen.push(args);
        return Promise.resolve(
          'planId' in args ? refused('plan_not_found') : { content: [{ type: 'text', text: 'ok' }], structuredContent: { now: '2026-07-18T12:00:00+02:00', day: { from: '2026-07-18T12:00:00+02:00', to: '2026-07-19T12:00:00+02:00' }, milestones: [] } },
        );
      },
    };
    expect(await readClock(agent, PLAN, ctx, () => undefined)).toEqual({ ok: true, value: { now: '2026-07-18T12:00:00+02:00' } });
    expect(seen).toEqual([{ planId: PLAN }, {}]);
  });

  it('a daily limit keeps its code and when it lifts (review of #378)', async () => {
    const limited: ToolCallResult = { isError: true, content: [{ type: 'text', text: 'Limit.' }], structuredContent: { code: 'demo_quota_exceeded', message: 'Limit.', retryAfterMs: 3_600_000 } };
    expect(await skipAhead(answering(limited), undefined, ctx, () => undefined)).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', retryAfterMs: 3_600_000 } });
  });

  it('nothing ahead, a refused jump, a broken reply or a call that throws: a failure as a value, logged with the turn id', async () => {
    const quiet = sandbox('heatwave');
    expect(await skipAhead(quiet.agent, undefined, ctx, () => undefined)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    for (const [reply, code] of [
      [refused('settings_version_conflict'), 'settings_version_conflict'],
      [refused('demo_quota_exceeded'), 'demo_quota_exceeded'],
      [{ content: [{ type: 'text', text: 'x' }], structuredContent: { now: 'yesterday' } }, 'output_schema_violation'],
      [new Error('network'), 'agent_unavailable'],
    ] as [ToolCallResult | Error, string][]) {
      const lines: LogEvent[] = [];
      expect(await skipAhead(answering(reply), undefined, ctx, (e) => lines.push(e))).toMatchObject({ ok: false, error: { code } });
      expect(lines).toEqual([expect.objectContaining({ level: 'warn', code, correlationId: 'c-clock', details: { step: 'get_milestones' } })]);
      expect(JSON.stringify(lines)).not.toMatch(/demo#|homeId/);
    }
  });
});

describe('cutThePower', () => {
  it('a calm day: the storm scenario first, then the clock goes to its storm start; Ana gets the first message', async () => {
    const { agent, phone, saveStorm } = sandbox('heatwave');
    const lines: LogEvent[] = [];
    const cut = await cutThePower(agent, { stormScenario: false, familyTold: false, saveStorm }, ctx, (e) => lines.push(e));
    expect(saveStorm).toHaveBeenCalledExactlyOnceWith({ scenarioId: 'storm-blackout' });
    expect(cut).toMatchObject({ ok: true, value: { changed: true, state: { now: '2026-07-18T19:42:00+02:00' } } });
    expect(phone.messages().map((m) => m.transition)).toEqual(['storm_started']);
    expect(lines).toContainEqual({ level: 'info', code: 'power_cut_simulated', correlationId: 'c-clock', details: { kind: 'storm_start' } });
  });

  it('the grid already down and the family told: nothing changes and nothing is saved', async () => {
    const { agent, phone, saveStorm } = sandbox('storm-blackout');
    await skipAhead(agent, undefined, ctx, () => undefined);
    const cut = await cutThePower(agent, { stormScenario: true, familyTold: true, saveStorm }, ctx, () => undefined);
    expect(cut).toMatchObject({ ok: true, value: { changed: false } });
    expect(saveStorm).not.toHaveBeenCalled();
    expect(phone.messages()).toHaveLength(1);
  });

  it('the grid down on its own clock but the family never told: the day plays again up to its storm, so Ana hears it', async () => {
    const { agent, saveStorm } = sandbox('storm-blackout');
    await skipAhead(agent, undefined, ctx, () => undefined);
    const cut = await cutThePower(agent, { stormScenario: true, familyTold: false, saveStorm }, ctx, () => undefined);
    expect(saveStorm).toHaveBeenCalledExactlyOnceWith({ restart: true });
    expect(cut).toMatchObject({ ok: true, value: { changed: true } });
  });

  it('the storm already over: the day starts again, up to its storm', async () => {
    const { agent, saveStorm } = sandbox('storm-blackout');
    for (let i = 0; i < 3; i++) await skipAhead(agent, undefined, ctx, () => undefined);
    const cut = await cutThePower(agent, { stormScenario: true, familyTold: true, saveStorm }, ctx, () => undefined);
    expect(saveStorm).toHaveBeenCalledExactlyOnceWith({ restart: true });
    expect(cut).toMatchObject({ ok: true, value: { changed: true, state: { next: { kind: 'essential_level' } } } });
  });

  it('a scenario that could not be saved, or a sandbox without a storm: a failure as a value, logged', async () => {
    const { agent } = sandbox('heatwave');
    const lines: LogEvent[] = [];
    expect(await cutThePower(agent, { stormScenario: false, familyTold: false, saveStorm: () => Promise.resolve(false) }, ctx, (e) => lines.push(e))).toMatchObject({
      ok: false,
      error: { code: 'agent_unavailable' },
    });
    expect(lines).toEqual([{ level: 'warn', code: 'agent_unavailable', correlationId: 'c-clock', details: { step: 'power_cut_scenario' } }]);
    // The scenario was saved but the sandbox lists no storm, even after a restart: never a silent "done".
    const noStorm = sandbox('heatwave');
    expect(await cutThePower(noStorm.agent, { stormScenario: false, familyTold: false, saveStorm: () => Promise.resolve(true) }, ctx, () => undefined)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });
});
