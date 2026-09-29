import type { RoomService } from '@cold-reserve/contracts';

/**
 * Room priority under a power budget (the inverter limit, plan §4ter and §11.6): rooms are taken in
 * priority order (rooms missing from the list come last, in their given order) and each is served if its
 * demand fits what is left; otherwise it waits with the reason. A smaller room further down may still
 * use what a larger one leaves. The planner uses this; the guard only checks the result (inverter_limit).
 */
export function allocateRooms(input: {
  demands: readonly { roomId: string; demandW: number }[];
  priority: readonly string[];
  budgetW: number;
}): RoomService[] {
  const rank = (id: string) => {
    const i = input.priority.indexOf(id);
    return i < 0 ? input.priority.length : i;
  };
  const ordered = input.demands.map((d, i) => ({ ...d, i })).sort((a, b) => rank(a.roomId) - rank(b.roomId) || a.i - b.i);
  let left = input.budgetW;
  return ordered.map((d): RoomService => {
    if (d.demandW <= left) {
      left -= d.demandW;
      return { roomId: d.roomId, state: 'served' };
    }
    return { roomId: d.roomId, state: 'waiting', waitingReason: 'inverter_limit' };
  });
}
