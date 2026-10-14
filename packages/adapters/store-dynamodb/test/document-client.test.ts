import { describe, expect, it } from 'vitest';
import { createDocumentTableClient, type DocumentSender } from '../src/index.js';

// The real AWS SDK v3 client is exercised with a stub `send`: we check the commands we build,
// never the network (cost rule: no AWS calls from tests).

function stub(...responses: unknown[]) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const sender: DocumentSender = {
    send: (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      const next = responses.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? {});
    },
  };
  return { sent, table: createDocumentTableClient({ tableName: 'ColdReserve-dev', sender }) };
}

const conditionFailed = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

describe('createDocumentTableClient', () => {
  it('reads one item by key', async () => {
    const { sent, table } = stub({ Item: { PK: 'HOME#demo', SK: 'PREFS', data: {} } });
    expect(await table.get('HOME#demo', 'PREFS')).toEqual({ PK: 'HOME#demo', SK: 'PREFS', data: {} });
    expect(sent[0]).toEqual({ name: 'GetCommand', input: { TableName: 'ColdReserve-dev', Key: { PK: 'HOME#demo', SK: 'PREFS' }, ConsistentRead: true } });
  });

  it('writes once with attribute_not_exists and reports a failed condition as a value', async () => {
    const { sent, table } = stub(conditionFailed());
    expect(await table.put({ PK: 'HOME#demo', SK: 'PLAN#p1' }, [{ attr: 'PK', op: 'not_exists' }])).toBe('condition_failed');
    expect(sent[0]?.input).toMatchObject({ ConditionExpression: 'attribute_not_exists(#c0)', ExpressionAttributeNames: { '#c0': 'PK' } });
  });

  it('builds the conditional update of apply_plan: status = proposed AND expiresAtMs > now', async () => {
    const { sent, table } = stub({});
    const result = await table.update('HOME#demo', 'PLAN#p1', { status: 'applied' }, [
      { attr: 'status', op: '=', value: 'proposed' },
      { attr: 'expiresAtMs', op: '>', value: 1000 },
    ]);
    expect(result).toBe('ok');
    expect(sent[0]).toEqual({
      name: 'UpdateCommand',
      input: {
        TableName: 'ColdReserve-dev',
        Key: { PK: 'HOME#demo', SK: 'PLAN#p1' },
        UpdateExpression: 'SET #s0 = :s0',
        ConditionExpression: '#c0 = :c0 AND #c1 > :c1',
        ExpressionAttributeNames: { '#s0': 'status', '#c0': 'status', '#c1': 'expiresAtMs' },
        ExpressionAttributeValues: { ':s0': 'applied', ':c0': 'proposed', ':c1': 1000 },
      },
    });
  });

  it('queries a key prefix and follows pagination', async () => {
    const { sent, table } = stub(
      { Items: [{ PK: 'HOME#demo', SK: 'GUARD#1' }], LastEvaluatedKey: { PK: 'HOME#demo', SK: 'GUARD#1' } },
      { Items: [{ PK: 'HOME#demo', SK: 'GUARD#2' }] },
    );
    expect((await table.query('HOME#demo', 'GUARD#')).map((i) => i.SK)).toEqual(['GUARD#1', 'GUARD#2']);
    expect(sent[0]?.input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeValues: { ':pk': 'HOME#demo', ':prefix': 'GUARD#' },
    });
    expect(sent[1]?.input).toMatchObject({ ExclusiveStartKey: { PK: 'HOME#demo', SK: 'GUARD#1' } });
  });

  it('lets any other failure through to the store, which maps it to store_unavailable', async () => {
    const { table } = stub(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }));
    await expect(table.get('HOME#demo', 'PREFS')).rejects.toThrow('Rate exceeded');
  });

  it('writes several items in one TransactWriteCommand (all or nothing)', async () => {
    const { sent, table } = stub({});
    await table.transactPut([
      { PK: 'HOME#demo', SK: 'EVENT#1' },
      { PK: 'HOME#demo', SK: 'PREFS' },
    ]);
    expect(sent[0]).toEqual({
      name: 'TransactWriteCommand',
      input: {
        TransactItems: [
          { Put: { TableName: 'ColdReserve-dev', Item: { PK: 'HOME#demo', SK: 'EVENT#1' } } },
          { Put: { TableName: 'ColdReserve-dev', Item: { PK: 'HOME#demo', SK: 'PREFS' } } },
        ],
      },
    });
  });

  it('puts a condition on one item of a transaction and reports a cancelled condition or a concurrent write as a value (#387); other cancellations throw', async () => {
    const cancelled = (code: string) => Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: code }, { Code: 'None' }] });
    const { sent, table } = stub(cancelled('ConditionalCheckFailed'), cancelled('TransactionConflict'), cancelled('TransactionConflict'), cancelled('ValidationError'));
    const items = [
      { PK: 'HOME#demo', SK: 'ALERT#k' },
      { PK: 'HOME#demo', SK: 'STORM#1' },
    ];
    expect(await table.transactPut(items, [[{ attr: 'PK', op: 'not_exists' }], []])).toBe('condition_failed');
    expect(sent[0]?.input).toEqual({
      TransactItems: [
        { Put: { TableName: 'ColdReserve-dev', Item: items[0], ConditionExpression: 'attribute_not_exists(#c0)', ExpressionAttributeNames: { '#c0': 'PK' } } },
        { Put: { TableName: 'ColdReserve-dev', Item: items[1] } },
      ],
    });
    expect(await table.transactPut(items, [[{ attr: 'PK', op: 'not_exists' }]])).toBe('conflict');
    // Without a condition, a concurrent write still throws (transient for the store); any other reason throws too.
    await expect(table.transactPut(items)).rejects.toThrow('Transaction cancelled');
    await expect(table.transactPut(items, [[{ attr: 'PK', op: 'not_exists' }]])).rejects.toThrow('Transaction cancelled');
  });

  it('queries newest first with a limit, and stops paginating once it has enough', async () => {
    const { sent, table } = stub({ Items: [{ PK: 'HOME#demo', SK: 'STORM#2' }], LastEvaluatedKey: { PK: 'HOME#demo', SK: 'STORM#2' } });
    expect((await table.query('HOME#demo', 'STORM#', { newestFirst: true, limit: 1 })).map((i) => i.SK)).toEqual(['STORM#2']);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toMatchObject({ ScanIndexForward: false, Limit: 1 });
  });
});