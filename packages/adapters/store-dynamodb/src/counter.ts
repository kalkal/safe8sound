import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DocumentSender } from './document-client.js';

/** A capped counter: `consume` adds `amount` (1 by default) under `key` if it still fits under `limit`; false at the cap. */
export interface Counter {
  consume(key: string, limit: number, expiresAtMs: number, amount?: number): Promise<boolean>;
  /** Gives one count back under `key`; nothing when there is nothing to give back. */
  release(key: string): Promise<void>;
}

/**
 * Quota counters on the single table (#17, the sim-api stack, decided in #17): one atomic conditional ADD per
 * use, so a cap holds with any number of Lambda instances. Items live under `DEMO#<key>` and expire with
 * their window (TTL). At the cap the condition fails and nothing is counted; any other failure goes to the
 * caller, which logs it.
 */
export function dynamoCounter(options: { tableName: string; sender: DocumentSender }): Counter {
  return {
    async consume(key, limit, expiresAtMs, amount = 1) {
      // A new item would take any amount: one larger than the whole cap never fits.
      if (amount > limit) return false;
      try {
        await options.sender.send(
          new UpdateCommand({
            TableName: options.tableName,
            Key: { PK: `DEMO#${key}`, SK: 'COUNT' },
            UpdateExpression: 'ADD #count :amount SET #ttl = if_not_exists(#ttl, :ttl)',
            ConditionExpression: 'attribute_not_exists(#count) OR #count <= :room',
            ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':amount': amount, ':room': limit - amount, ':ttl': Math.ceil(expiresAtMs / 1000) },
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
    async release(key) {
      try {
        // Never below zero and never a new item: the condition fails when there is no count to give back.
        await options.sender.send(
          new UpdateCommand({
            TableName: options.tableName,
            Key: { PK: `DEMO#${key}`, SK: 'COUNT' },
            UpdateExpression: 'ADD #count :minusOne',
            ConditionExpression: '#count > :zero',
            ExpressionAttributeNames: { '#count': 'count' },
            ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
          }),
        );
      } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return;
        throw error;
      }
    },
  };
}
