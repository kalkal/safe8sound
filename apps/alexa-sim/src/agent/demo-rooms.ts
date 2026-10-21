import type { Household } from '@cold-reserve/contracts';
import { roomNameOf } from '@cold-reserve/core';
import demoHome from '@cold-reserve/source-simulator/demo-home.json' with { type: 'json' };

// The scripted home is the invented demo home, never the real one: its rooms by id with the names the server's profile
// gives them, base names from demo-home.json and the protected bedroom by core's roomNameOf (owner, 21 Oct).

/** The demo home's room names for who is at home: "Leo's room" only while he is there. */
export const demoRoomNames = (household: Household): Readonly<Record<string, string>> =>
  Object.fromEntries(demoHome.rooms.map((room) => [room.id, roomNameOf(room, household)]));
