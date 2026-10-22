import { AdvanceClockOutputSchema, GetMilestonesOutputSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createScriptedClock } from '../src/agent/scripted-clock.js';
import { createScriptedPhone } from '../src/phone/phone-feed.js';

// The scripted home's simulated clock (time pack, 12 Oct): the sandbox's clock tools over the script's storm night,
// in the same shapes the server returns (the contracts parse them), the phone told at each moment it passes.

const milestones = (clock: ReturnType<typeof createScriptedClock>) => GetMilestonesOutputSchema.parse(clock.call('get_milestones', {})?.structuredContent);

describe('createScriptedClock', () => {
  it('the storm night has its three moments; a calm scenario has none', () => {
    const clock = createScriptedClock();
    expect(milestones(clock).milestones).toEqual([]);
    clock.call('set_scenario', { scenarioId: 'storm-blackout' });
    expect(milestones(clock).milestones.map((m) => m.kind)).toEqual(['storm_start', 'essential_level', 'power_back']);
  });

  it('each jump tells the phone what it passes, once; a jump to a later moment passes the ones before it', () => {
    const phone = createScriptedPhone();
    const clock = createScriptedClock({ phone, startScenario: 'storm-blackout' });
    const [storm, , back] = milestones(clock).milestones;
    const first = clock.call('advance_clock', { kind: storm?.kind, at: storm?.at });
    expect(AdvanceClockOutputSchema.parse(first?.structuredContent).now).toBe(storm?.at);
    expect(phone.messages().map((m) => m.transition)).toEqual(['storm_started']);
    clock.call('advance_clock', { kind: back?.kind, at: back?.at });
    expect(phone.messages().map((m) => m.transition)).toEqual(['power_back', 'essential_level', 'storm_started']);
    expect(milestones(clock).milestones).toEqual([]);
  });

  it('a moment not ahead is refused as the server does; a restart plays the night again', () => {
    const clock = createScriptedClock({ startScenario: 'storm-blackout' });
    const [storm] = milestones(clock).milestones;
    clock.call('advance_clock', { kind: storm?.kind, at: storm?.at });
    expect(clock.call('advance_clock', { kind: storm?.kind, at: storm?.at })).toMatchObject({ isError: true, structuredContent: { code: 'invalid_input' } });
    clock.call('set_scenario', { restart: true });
    expect(milestones(clock).milestones).toHaveLength(3);
  });

it('a new play of the day (restart, another scenario) empties the phone, as the server starts a new inbox (owner, 18 Oct)', () => {    const phone = createScriptedPhone();    const clock = createScriptedClock({ phone, startScenario: 'storm-blackout' });    const [, , back] = milestones(clock).milestones;    clock.call('advance_clock', { kind: back?.kind, at: back?.at });    expect(phone.messages()).toHaveLength(3);    clock.call('set_scenario', { restart: true });    expect(phone.messages()).toEqual([]);    clock.call('advance_clock', { kind: back?.kind, at: back?.at });    clock.call('set_scenario', { scenarioId: 'heatwave' });    expect(phone.messages()).toEqual([]);  });
  it('answers only the clock tools', () => {
    expect(createScriptedClock().call('apply_plan', {})).toBeUndefined();
  });

  it("now() is the time the clock shows: every scripted reading is stamped with it, never a fixed time (option B, 20 Oct)", () => {
    const clock = createScriptedClock();
    expect(clock.now()).toBe(milestones(clock).now);
    expect(clock.now()).toBe(milestones(clock).day.from);
    clock.call('set_scenario', { scenarioId: 'storm-blackout' });
    const [storm] = milestones(clock).milestones;
    clock.call('advance_clock', { kind: storm?.kind, at: storm?.at });
    expect(clock.now()).toBe(storm?.at);
  });
});
