import { describe, expect, it } from 'vitest';
import { SCRIPT_FIXTURES, SCRIPT_FIXTURE_NAMES } from '../src/agent/script-fixtures.js';

// The scripted home is the invented one (the grandpa Leo): every room a scripted card shows has its own name
// ("Leo's room"), never a name made from its id ("Bedroom 1"), as the server's cards do (#422).

const DEMO_ROOM_NAMES = { 'bedroom-1': "Leo's room", 'bedroom-2': 'Second bedroom', study: 'Study', living: 'Living room' } as const;
type RoomId = keyof typeof DEMO_ROOM_NAMES;

/** Every room a card names: [id, the name the card gives it]. */
function roomsOf(fixture: (typeof SCRIPT_FIXTURE_NAMES)[number]): [string, string | undefined][] {
  const card = SCRIPT_FIXTURES[fixture]();
  switch (card.tool) {
    case 'get_safe_room_status':
      return [[card.result.safeRoomId, card.result.safeRoomName]];
    case 'get_home_status':
      return card.result.rooms.map((r): [string, string | undefined] => [r.roomId, r.name]);
    case 'plan_comfort':
      return 'surplus' in card.result && card.result.surplus !== undefined ? card.result.surplus.rooms.map((r): [string, string | undefined] => [r.roomId, r.name]) : [];
    case 'get_preferences':
      return card.result.preferences.roomPriority.map((id): [string, string | undefined] => [id, card.result.rooms?.find((r) => r.id === id)?.name]);
    default:
      return [];
  }
}

describe('the rooms of the scripted cards', () => {
  it.each(SCRIPT_FIXTURE_NAMES)('%s: every room it shows has the name of the demo home', (fixture) => {
    for (const [id, name] of roomsOf(fixture)) {
      expect(name, `${fixture}: ${id}`).toBe(DEMO_ROOM_NAMES[id as RoomId]);
    }
  });

  it('covers a safe-room card and a floor plan, so the check is not empty', () => {
    expect(roomsOf('safe-room-storm')).toEqual([['bedroom-1', "Leo's room"]]);
    expect(roomsOf('home-storm').length).toBeGreaterThan(1);
  });
});
