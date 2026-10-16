// The safe room choice, shared by the Preferences card and the settings drawer (#402): one rule, one place. The safe
// room always comes first in the room priority, and the priority lists every room once.

interface RoomChoice {
  safeRoomId: string;
  roomPriority: readonly string[];
}

/** The preferences with another safe room: it moves to the head of the room priority, the rest keep their order. */
export function withSafeRoom<T extends RoomChoice>(choice: T, roomId: string): T {
  return { ...choice, safeRoomId: roomId, roomPriority: [roomId, ...choice.roomPriority.filter((id) => id !== roomId)] };
}

/** True when the tool would refuse this choice: the safe room is not first, or a room is listed twice. */
export function priorityBroken(choice: RoomChoice): boolean {
  return choice.roomPriority[0] !== choice.safeRoomId || new Set(choice.roomPriority).size !== choice.roomPriority.length;
}
