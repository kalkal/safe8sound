import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';
import { documentSender, type DocumentSender } from './document-client.js';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const DynamoEnvSchema = z.object({
  STATE_TABLE_NAME: z.string().min(3).max(255),
  AWS_REGION: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  // The names the CDK stacks pass to the Lambdas.
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

/** The shared table's name and SDK client settings, from env, for every Lambda that uses the table. */
export function dynamoSettingsFrom(env: Readonly<Record<string, string | undefined>>): Result<{ tableName: string; client: DynamoClientSettings }, ErrorEnvelope> {
  const parsed = DynamoEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message.slice(0, 200) }));
    return err(toolError('invalid_config', 'The DynamoDB settings are missing or invalid.', { details: { issues } }));
  }
  const c = parsed.data;
  return ok({
    tableName: c.STATE_TABLE_NAME,
    client: { region: c.AWS_REGION, connectionTimeoutMs: c.STATE_STORE_CONNECT_TIMEOUT_MS, requestTimeoutMs: c.STATE_STORE_REQUEST_TIMEOUT_MS, maxAttempts: c.STATE_STORE_MAX_ATTEMPTS },
  });
}

/** A command sender on a real SDK document client: for a Lambda that does not otherwise need the SDK. */
export const sdkDocumentSender = (s: DynamoClientSettings): DocumentSender => documentSender(DynamoDBDocumentClient.from(defaultDynamoClient(s)));
