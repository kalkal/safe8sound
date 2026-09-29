import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type GetCommandOutput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Condition, TableClient, TableItem, WriteOutcome } from './table.js';

export type TableCommand = GetCommand | PutCommand | UpdateCommand | QueryCommand | TransactWriteCommand;

/** What the table client needs from the AWS SDK: injected, so tests never reach the network. */
export interface DocumentSender {
  send(command: TableCommand): Promise<unknown>;
}

/** Adapts the SDK document client (built with region and timeouts from config) to a sender. */
export const documentSender = (client: DynamoDBDocumentClient): DocumentSender => ({
  send: (command) => client.send(command as GetCommand),
});

interface Expression {
  readonly expression: string;
  readonly names: Record<string, string>;
  readonly values: Record<string, unknown>;
}

function conditionExpression(conditions: readonly Condition[]): Expression {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts = conditions.map((c, i) => {
    names[`#c${String(i)}`] = c.attr;
    if (c.op === 'not_exists') return `attribute_not_exists(#c${String(i)})`;
    values[`:c${String(i)}`] = c.value;
    return `#c${String(i)} ${c.op} :c${String(i)}`;
  });
  return { expression: parts.join(' AND '), names, values };
}

const isConditionFailure = (error: unknown) => error instanceof Error && error.name === 'ConditionalCheckFailedException';

async function conditional(write: () => Promise<unknown>): Promise<WriteOutcome> {
  try {
    await write();
    return 'ok';
  } catch (error) {
    if (isConditionFailure(error)) return 'condition_failed';
    throw error;
  }
}

export function createDocumentTableClient(options: { tableName: string; sender: DocumentSender }): TableClient {
  const { tableName: TableName, sender } = options;
  return {
    async get(pk, sk) {
      const out = (await sender.send(new GetCommand({ TableName, Key: { PK: pk, SK: sk }, ConsistentRead: true }))) as GetCommandOutput;
      return out.Item as TableItem | undefined;
    },

    put(item, conditions = []) {
      const c = conditionExpression(conditions);
      return conditional(() =>
        sender.send(
          new PutCommand({
            TableName,
            Item: item,
            ...(conditions.length > 0 && { ConditionExpression: c.expression, ExpressionAttributeNames: c.names }),
            ...(Object.keys(c.values).length > 0 && { ExpressionAttributeValues: c.values }),
          }),
        ),
      );
    },

    update(pk, sk, set, conditions) {
      const c = conditionExpression(conditions);
      const setNames: Record<string, string> = {};
      const setValues: Record<string, unknown> = {};
      const assignments = Object.entries(set).map(([attr, value], i) => {
        setNames[`#s${String(i)}`] = attr;
        setValues[`:s${String(i)}`] = value;
        return `#s${String(i)} = :s${String(i)}`;
      });
      return conditional(() =>
        sender.send(
          new UpdateCommand({
            TableName,
            Key: { PK: pk, SK: sk },
            UpdateExpression: `SET ${assignments.join(', ')}`,
            ConditionExpression: c.expression,
            ExpressionAttributeNames: { ...setNames, ...c.names },
            ExpressionAttributeValues: { ...setValues, ...c.values },
          }),
        ),
      );
    },

    async query(pk, skPrefix) {
      const items: TableItem[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const out = (await sender.send(
          new QueryCommand({
            TableName,
            KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: { ':pk': pk, ':prefix': skPrefix },
            ConsistentRead: true,
            ...(startKey && { ExclusiveStartKey: startKey }),
          }),
        )) as QueryCommandOutput;
        items.push(...((out.Items ?? []) as TableItem[]));
        startKey = out.LastEvaluatedKey;
      } while (startKey);
      return items;
    },

    async transactPut(items) {
      await sender.send(new TransactWriteCommand({ TransactItems: items.map((Item) => ({ Put: { TableName, Item } })) }));
    },
  };
}
