// The narrow slice of the single table the store needs. The AWS SDK client and the in-process
// fake both implement it, so the store logic (keys, TTL, conditions, validation) is shared.

export interface TableItem {
  readonly PK: string;
  readonly SK: string;
  readonly [attribute: string]: unknown;
}

/** A condition on one top-level attribute; several conditions are joined with AND. */
export type Condition =
  | { readonly attr: string; readonly op: 'not_exists' }
  | { readonly attr: string; readonly op: '=' | '>'; readonly value: string | number };

export type WriteOutcome = 'ok' | 'condition_failed';

export interface QueryOptions {
  /** Highest sort key first (DynamoDB ScanIndexForward = false). */
  readonly newestFirst?: boolean;
  /** At most this many items. */
  readonly limit?: number;
}

/** Infrastructure failures (network, throttling) are thrown; a failed condition is a value. */
export interface TableClient {
  get(pk: string, sk: string): Promise<TableItem | undefined>;
  put(item: TableItem, conditions?: readonly Condition[]): Promise<WriteOutcome>;
  update(pk: string, sk: string, set: Readonly<Record<string, unknown>>, conditions: readonly Condition[]): Promise<WriteOutcome>;
  /** Items of the partition whose sort key starts with the prefix, in sort-key order (or reversed). */
  query(pk: string, skPrefix: string, options?: QueryOptions): Promise<TableItem[]>;
  /** Writes all the items or none (DynamoDB TransactWriteItems, at most 100 items). */
  transactPut(items: readonly TableItem[]): Promise<void>;
}
