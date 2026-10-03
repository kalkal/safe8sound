import type { ErrorEnvelope, HomeId, HomeProfile, Preferences, Result, StormId } from '@cold-reserve/contracts';
import type { Clock, DeviceAdapter, Logger, Notifier, StateStoreFactory } from '@cold-reserve/core';
import type { ComfortHome } from '../comfort-plan/deps.js';
import type { StormModeConfig } from './config.js';

/** What the module needs of a home: the same view as comfort-plan (source, forecast, profile). */
export type StormHome = ComfortHome;

/** Everything the storm-mode module needs; built per server by the composition root (plan §9.2). */
export interface StormModeDeps {
  readonly homes: (homeId: HomeId) => StormHome | undefined;
  /** F5's StateStore: the storm sessions, and the saved preferences through `preferencesFor`. */
  readonly storeFor: StateStoreFactory;
  /** The saved preferences (safe room, thresholds, contacts, language), or the config defaults. */
  readonly preferencesFor: (homeId: HomeId, profile: HomeProfile) => Promise<Result<Preferences, ErrorEnvelope>>;
  /** Wall clock of the sessions and the messages; the same clock as the store's TTL. */
  readonly clock: Clock;
  readonly config: StormModeConfig;
  /** Where family messages go: the simulated in-app phone during the hackathon. */
  readonly notifier: Notifier;
  readonly newStormId: () => StormId;
  /** The devices made safe on entering a storm (queue item 7): the simulated adapter only; absent = none. */
  readonly devices?: DeviceAdapter;
  /** Where the module's warn lines go (a device that did not answer); the server's logger. */
  readonly logger: Logger;
}
