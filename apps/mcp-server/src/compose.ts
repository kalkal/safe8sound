import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SandboxHomeIdSchema, ok, type ErrorEnvelope, type HomeId, type HomeProfile, type Result } from '@cold-reserve/contracts';
import { seededRng, type Clock, type StateStoreFactory } from '@cold-reserve/core';
import { demoProfile } from '@cold-reserve/source-simulator';
import {
  createDocumentTableClient,
  defaultDynamoClient,
  documentSender,
  dynamoSettingsFrom,
  dynamoStateStoreFactory,
  type DynamoClientSettings,
  type StoreErrorEvent,
} from '@cold-reserve/store-dynamodb';
import { preferencesModule } from './modules/preferences.js';
import { defaultPreferencesFor, type PreferencesConfig } from './preferences-config.js';
import type { CapabilityModule } from './registry.js';

// Composition of the capability modules, shared by the local Node entry and the Lambda entry.

/**
 * Profiles known to the server: the demo home for `demo` and every visitor sandbox `demo#…`.
 * The real home (`home`) has no profile until F2, so modules that need rooms stay off for it.
 */
export function profileFor(homeId: HomeId): HomeProfile | undefined {
  return homeId === 'demo' || SandboxHomeIdSchema.safeParse(homeId).success ? demoProfile() : undefined;
}

export interface ComposeOptions {
  readonly preferences: PreferencesConfig;
  readonly storeFor: StateStoreFactory;
  readonly clock: Clock;
  /** A home's own scenario clock (C2b), known once the app is built: the entries bind it late. */
  readonly clockFor?: (homeId: HomeId) => Clock | undefined;
}

export function composeModules(opts: ComposeOptions): Result<CapabilityModule[], ErrorEnvelope> {
  // Fail at startup, not at the first call: the defaults must fit the demo home.
  const demoDefaults = defaultPreferencesFor(opts.preferences, demoProfile());
  if (!demoDefaults.ok) return demoDefaults;

  const preferences = preferencesModule({
    storeFor: opts.storeFor,
    limits: opts.preferences.limits,
    roomIdsFor: (homeId) => profileFor(homeId)?.rooms.map((room) => room.id) ?? [],
    defaultsFor: () => demoDefaults.value,
    clock: opts.clock,
    ...(opts.clockFor === undefined ? {} : { clockFor: opts.clockFor }),
  });
  return ok([{ ...preferences, enabledFor: (homeId) => profileFor(homeId) !== undefined }]);
}

/** The DynamoDB store for Lambda: table and explicit SDK timeouts from env; nothing is called here. */
export function createDynamoStoreFactory(
  env: Readonly<Record<string, string | undefined>>,
  deps: {
    readonly clock: Clock;
    readonly onError?: (event: StoreErrorEvent) => void;
    /** Injected in tests to check the settings; defaults to the real SDK client. */
    readonly buildClient?: (settings: DynamoClientSettings) => DynamoDBClient;
  },
): Result<StateStoreFactory, ErrorEnvelope> {
  const settings = dynamoSettingsFrom(env);
  if (!settings.ok) return settings;
  const client = DynamoDBDocumentClient.from((deps.buildClient ?? defaultDynamoClient)(settings.value.client));
  const table = createDocumentTableClient({ tableName: settings.value.tableName, sender: documentSender(client) });
  // Only log sort keys use the Rng; seed it per process so two Lambdas never share a sequence.
  const rng = seededRng((deps.clock.now() ^ process.pid) >>> 0);
  return ok(dynamoStateStoreFactory({ table, clock: deps.clock, rng, ...(deps.onError === undefined ? {} : { onError: deps.onError }) }));
}
