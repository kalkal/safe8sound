import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SandboxHomeIdSchema, err, ok, toolError, type ErrorEnvelope, type HomeId, type HomeProfile, type Result } from '@cold-reserve/contracts';
import { seededRng, type Clock, type StateStoreFactory } from '@cold-reserve/core';
import { demoProfile } from '@cold-reserve/source-simulator';
import { createDocumentTableClient, documentSender, dynamoStateStoreFactory, type StoreErrorEvent } from '@cold-reserve/store-dynamodb';
import { z } from 'zod';
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
  });
  return ok([{ ...preferences, enabledFor: (homeId) => profileFor(homeId) !== undefined }]);
}

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const DynamoEnvSchema = z.object({
  STATE_TABLE_NAME: z.string().min(3).max(255),
  AWS_REGION: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  // The names the CDK stack passes to the Lambda.
  STATE_STORE_CONNECT_TIMEOUT_MS: positiveInt(500),
  STATE_STORE_REQUEST_TIMEOUT_MS: positiveInt(1500),
  STATE_STORE_MAX_ATTEMPTS: positiveInt(3),
});

/** What the SDK client is built with: region, explicit timeouts and retry attempts. */
export interface DynamoClientSettings {
  readonly region: string;
  readonly connectionTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxAttempts: number;
}

export const defaultDynamoClient = (s: DynamoClientSettings): DynamoDBClient =>
  new DynamoDBClient({
    region: s.region,
    maxAttempts: s.maxAttempts,
    requestHandler: { connectionTimeout: s.connectionTimeoutMs, requestTimeout: s.requestTimeoutMs },
  });

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
  const parsed = DynamoEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message.slice(0, 200) }));
    return err(toolError('invalid_config', 'The DynamoDB settings are missing or invalid.', { details: { issues } }));
  }
  const c = parsed.data;
  const client = DynamoDBDocumentClient.from(
    (deps.buildClient ?? defaultDynamoClient)({
      region: c.AWS_REGION,
      connectionTimeoutMs: c.STATE_STORE_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: c.STATE_STORE_REQUEST_TIMEOUT_MS,
      maxAttempts: c.STATE_STORE_MAX_ATTEMPTS,
    }),
  );
  const table = createDocumentTableClient({ tableName: c.STATE_TABLE_NAME, sender: documentSender(client) });
  // Only log sort keys use the Rng; seed it per process so two Lambdas never share a sequence.
  const rng = seededRng((deps.clock.now() ^ process.pid) >>> 0);
  return ok(dynamoStateStoreFactory({ table, clock: deps.clock, rng, ...(deps.onError === undefined ? {} : { onError: deps.onError }) }));
}
