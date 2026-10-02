import { describe, expect, it } from 'vitest';
import { dynamoCounter, type DocumentSender } from '../src/index.js';

// The quota counter on the single table (#17, the sim-api stack, decided in #17): one atomic UpdateItem per
// use, so a cap holds with any number of Lambda instances. A stub `send`: never the network.

function stub(...responses: unknown[]) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const sender: DocumentSender = {
    send: (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      const next = responses.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? {});
    },
  };
  return { sent, counter: dynamoCounter({ tableName: 'ColdReserve-dev', sender }) };
}

const conditionFailed = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
const END = Date.UTC(2026, 9, 3, 0, 0, 0);

describe('dynamoCounter', () => {
  it('counts one more under the key with one conditional ADD, and keeps the item until the window ends (TTL)', async () => {
    const { sent, counter } = stub({});
    expect(await counter.consume('TURNS#judges#2026-10-02', 20, END)).toBe(true);
    expect(sent).toEqual([
      {
        name: 'UpdateCommand',
        input: {
          TableName: 'ColdReserve-dev',
          Key: { PK: 'DEMO#TURNS#judges#2026-10-02', SK: 'COUNT' },
          UpdateExpression: 'ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': 1, ':limit': 20, ':ttl': END / 1000 },
        },
      },
    ]);
  });

  it('answers false at the cap (the condition failed): nothing is counted', async () => {
    const { counter } = stub(conditionFailed());
    expect(await counter.consume('FAIL#203.0.113.7#2026-10-02T12', 10, END)).toBe(false);
  });

  it('lets any other failure through to the caller (it is logged there, never swallowed)', async () => {
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ProvisionedThroughputExceededException' });
    const { counter } = stub(throttled);
    await expect(counter.consume('TURNS#GLOBAL#2026-10-02', 30, END)).rejects.toBe(throttled);
  });

  it('rounds the TTL up to whole seconds, as DynamoDB expects', async () => {
    const { sent, counter } = stub({});
    await counter.consume('k', 1, END + 1500);
    expect((sent[0]?.input['ExpressionAttributeValues'] as Record<string, number>)[':ttl']).toBe(END / 1000 + 2);
  });
});

describe('dynamoCounter.release', () => {
  it('gives one count back with one conditional ADD of -1 (never below zero, never creates an item)', async () => {
    const { sent, counter } = stub({});
    await counter.release('ATTEMPT#abc#2026-10-02T12');
    expect(sent).toEqual([
      {
        name: 'UpdateCommand',
        input: {
          TableName: 'ColdReserve-dev',
          Key: { PK: 'DEMO#ATTEMPT#abc#2026-10-02T12', SK: 'COUNT' },
          UpdateExpression: 'ADD #count :minusOne',
          ConditionExpression: '#count > :zero',
          ExpressionAttributeNames: { '#count': 'count' },
          ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
        },
      },
    ]);
  });

  it('does nothing when there is nothing to give back (the condition failed)', async () => {
    const { counter } = stub(conditionFailed());
    await expect(counter.release('k')).resolves.toBeUndefined();
  });

  it('lets any other failure through to the caller', async () => {
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const { counter } = stub(throttled);
    await expect(counter.release('k')).rejects.toBe(throttled);
  });
});
