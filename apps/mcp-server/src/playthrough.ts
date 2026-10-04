import type { HomeId } from '@cold-reserve/contracts';
import type { Clock, StateStoreFactory } from '@cold-reserve/core';

/**
 * Every store a home opens is scoped to the current playthrough of its scenario (#234): a replayed day (daily anchor)
 * or a restarted sandbox never sees the last playthrough's storm sessions or family messages. A home whose clock
 * has no playthrough (a real clock) keeps one for ever.
 */
export const withPlaythrough =
  (storeFor: StateStoreFactory, clockOf: (homeId: HomeId) => Clock | undefined): StateStoreFactory =>
  (homeId, scope) => {
    const playthrough = clockOf(homeId)?.playthrough?.();
    return storeFor(homeId, playthrough === undefined ? scope : { ...scope, playthrough });
  };
