import { HomeStatusSchema } from '@cold-reserve/contracts';
import { hotDayPlan, homeCalm, homeInStorm, safeRoomCalm, safeRoomInStorm } from '@cold-reserve/ui-cards';
import { describe, expect, it } from 'vitest';
import { withDemoHomeNames } from '../../src/agent/script-fixtures.js';
import type { CardSlot } from '../../src/agent/wire.js';
import type { Agent } from '../../src/agent/agent.js';
import { fetchHome, homeAfterApply, homeFor, homeNamedFor, initialHome } from '../../src/ui/home.js';

// "Show my home" (#204): the panel shows the home the answers describe. A get_home_status result is shown as it is,
// in any mode. The scripted home also follows the scene (storm, power back, a plan applied); the remote home never
// shows a scripted fixture.

const storm: CardSlot = { tool: 'get_safe_room_status', result: safeRoomInStorm() };
const calm: CardSlot = { tool: 'get_safe_room_status', result: { ...safeRoomCalm(), stormPhase: 'ended' } };

describe('homeFor', () => {
  it('starts on the calm scripted home, and on nothing in remote mode', () => {
    expect(initialHome('scripted')).toEqual(withDemoHomeNames(homeCalm()));
    expect(initialHome('remote')).toBeUndefined();
  });

  it('a get_home_status result is shown as it is, in both modes', () => {
    const status = HomeStatusSchema.parse({ ...homeCalm(), batterySocPct: 55 });
    expect(homeFor([{ tool: 'get_home_status', result: status }], undefined, 'remote')).toEqual(status);
    expect(homeFor([{ tool: 'get_home_status', result: status }], homeCalm(), 'scripted')).toEqual(status);
  });

  it('scripted: the storm turns the home to the storm home, power back to the calm one', () => {
    expect(homeFor([storm], homeCalm(), 'scripted')).toEqual(withDemoHomeNames(homeInStorm()));
    expect(homeFor([calm], homeInStorm(), 'scripted')).toEqual(withDemoHomeNames(homeCalm()));
  });

  it('scripted: the home is named for who is at home: no Leo with no one at risk, the room ids unchanged (owner, 21 Oct)', () => {
    const home = homeFor([storm], homeCalm(), 'scripted', 'no-one-at-risk');
    expect(JSON.stringify(home)).not.toMatch(/Leo/);
    expect(home?.rooms.map((r) => r.roomId)).toEqual(homeInStorm().rooms.map((r) => r.roomId));
    expect(home?.rooms.find((r) => r.roomId === 'bedroom-1')?.name).toBe('Bedroom');
  });

  it('scripted: the home panel protects the safe room chosen in Settings, the room the answers name (review of #493)', () => {
    const served = (home: ReturnType<typeof homeFor>) => home?.rooms.filter((r) => r.state === 'served').map((r) => [r.roomId, r.name, r.tempC]);
    expect(served(homeFor([storm], homeCalm(), 'scripted', 'older-man', 'study'))).toEqual([['study', 'Study', 26.8]]);
    expect(served(homeFor([storm], homeCalm(), 'scripted', 'older-man'))).toEqual([['bedroom-1', "Leo's room", 26.8]]);
    expect(homeNamedFor(withDemoHomeNames(homeInStorm()), 'scripted', 'no-one-at-risk', 'study')?.rooms.find((r) => r.state === 'served')?.roomId).toBe('study');
  });

  it('remote: no fixture ever replaces what the home really said', () => {
    expect(homeFor([storm], undefined, 'remote')).toBeUndefined();
    expect(homeFor([calm], homeCalm(), 'remote')).toEqual(homeCalm());
  });

  it('an answer about something else keeps the home it had', () => {
    expect(homeFor([{ tool: 'plan_comfort', result: hotDayPlan() }], homeInStorm(), 'scripted')).toEqual(homeInStorm());
  });

  it('scripted: a plan applied pre-cools the second bedroom too', () => {
    const after = homeAfterApply(homeCalm(), 'scripted');
    expect(after?.rooms.find((r) => r.roomId === 'bedroom-2')?.state).toBe('served');
    expect(homeAfterApply(homeCalm(), 'remote')).toEqual(homeCalm());
  });

  it("scripted: every room of the home panel has the demo home's name, before and after a plan, in calm and in the storm (#422)", () => {
    const names = (h: ReturnType<typeof initialHome>) => h?.rooms.map((r) => [r.roomId, r.name]);
    const expected = [
      ['bedroom-1', "Leo's room"],
      ['bedroom-2', 'Second bedroom'],
      ['living', 'Living room'],
      ['study', 'Study'],
    ];
    const calmHome = initialHome('scripted');
    expect(names(calmHome)).toEqual(expected);
    expect(names(homeAfterApply(calmHome, 'scripted'))).toEqual(expected);
    expect(names(homeFor([storm], calmHome, 'scripted'))).toEqual(expected);
  });
});

describe('fetchHome (#262): the remote panel reads get_home_status on demand', () => {
  const ctx = { correlationId: 'c1' };
  const agentWith = (result: unknown) => ({ canCallTools: true, ask: () => Promise.reject(new Error('unused')), callTool: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) }) as unknown as Agent;

  it('reads the home the tool returned, as the contract parses it', async () => {
    const reply = { content: [{ type: 'text', text: 'Home.' }], structuredContent: homeCalm() };
    expect(await fetchHome(agentWith(reply), ctx)).toEqual({ ok: true, value: homeCalm() });
  });

  it('a tool error, a result that breaks the contract or a call that throws is "unreachable", never a fixture', async () => {
    const failed = { isError: true, content: [{ type: 'text', text: 'No.' }], structuredContent: { code: 'agent_unavailable' } };
    expect(await fetchHome(agentWith(failed), ctx)).toMatchObject({ ok: false });
    expect(await fetchHome(agentWith({ content: [{ type: 'text', text: 'x' }], structuredContent: { batterySocPct: 'full' } }), ctx)).toMatchObject({ ok: false });
    expect(await fetchHome(agentWith(new Error('network')), ctx)).toMatchObject({ ok: false });
  });
});
