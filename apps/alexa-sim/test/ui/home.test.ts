import { HomeStatusSchema } from '@cold-reserve/contracts';
import { hotDayPlan, homeCalm, homeInStorm, safeRoomCalm, safeRoomInStorm } from '@cold-reserve/ui-cards';
import { describe, expect, it } from 'vitest';
import type { CardSlot } from '../../src/agent/wire.js';
import { homeAfterApply, homeFor, initialHome } from '../../src/ui/home.js';

// "Show my home" (#204): the panel shows the home the answers describe. A get_home_status result is shown as it is,
// in any mode. The scripted home also follows the scene (storm, power back, a plan applied); the remote home never
// shows a scripted fixture.

const storm: CardSlot = { tool: 'get_safe_room_status', result: safeRoomInStorm() };
const calm: CardSlot = { tool: 'get_safe_room_status', result: { ...safeRoomCalm(), stormPhase: 'ended' } };

describe('homeFor', () => {
  it('starts on the calm scripted home, and on nothing in remote mode', () => {
    expect(initialHome('scripted')).toEqual(homeCalm());
    expect(initialHome('remote')).toBeUndefined();
  });

  it('a get_home_status result is shown as it is, in both modes', () => {
    const status = HomeStatusSchema.parse({ ...homeCalm(), batterySocPct: 55 });
    expect(homeFor([{ tool: 'get_home_status', result: status }], undefined, 'remote')).toEqual(status);
    expect(homeFor([{ tool: 'get_home_status', result: status }], homeCalm(), 'scripted')).toEqual(status);
  });

  it('scripted: the storm turns the home to the storm home, power back to the calm one', () => {
    expect(homeFor([storm], homeCalm(), 'scripted')).toEqual(homeInStorm());
    expect(homeFor([calm], homeInStorm(), 'scripted')).toEqual(homeCalm());
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
});
