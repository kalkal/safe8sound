import type { Condition, TableClient, TableItem } from '../src/table.js';

// In-process fake of the single table for tests and local runs (no Docker on the dev PC).
// It implements the same conditional-write semantics the SDK client asks DynamoDB for.

function holds(item: TableItem | undefined, condition: Condition): boolean {
  const current = item?.[condition.attr];
  switch (condition.op) {
    case 'not_exists':
      return current === undefined;
    case '=':
      return current === condition.value;
    case '>':
      return typeof current === typeof condition.value && (current as number | string) > condition.value;
  }
}

export interface FakeTableOptions {
  /**
   * The next conditional transactions that DynamoDB cancels for a concurrent write on one of their items
   * (TransactionConflict): each is `conflict`, with nothing written (review of #387).
   */
  readonly transactionConflicts?: number;
}

export function createFakeTable(options: FakeTableOptions = {}): TableClient {
  let conflicts = options.transactionConflicts ?? 0;
  const partitions = new Map<string, Map<string, TableItem>>();
  const partition = (pk: string) => {
    let p = partitions.get(pk);
    if (!p) {
      p = new Map();
      partitions.set(pk, p);
    }
    return p;
  };
  const clone = <T>(value: T): T => structuredClone(value);

  return {
    get: (pk, sk) => Promise.resolve(clone(partition(pk).get(sk))),

    put(item, conditions = []) {
      const p = partition(item.PK);
      if (!conditions.every((c) => holds(p.get(item.SK), c))) return Promise.resolve('condition_failed');
      p.set(item.SK, clone(item));
      return Promise.resolve('ok');
    },

    update(pk, sk, set, conditions) {
      const p = partition(pk);
      const current = p.get(sk);
      if (!conditions.every((c) => holds(current, c))) return Promise.resolve('condition_failed');
      p.set(sk, { ...(current ?? { PK: pk, SK: sk }), ...clone(set) });
      return Promise.resolve('ok');
    },

    query: (pk, skPrefix, options = {}) => {
      const sorted = [...partition(pk)].filter(([sk]) => sk.startsWith(skPrefix)).sort(([a], [b]) => (a < b ? -1 : 1));
      if (options.newestFirst === true) sorted.reverse();
      return Promise.resolve(sorted.slice(0, options.limit ?? sorted.length).map(([, item]) => clone(item)));
    },

    transactPut(items, conditions = []) {
      if (conflicts > 0 && conditions.some((c) => c.length > 0)) {
        conflicts -= 1;
        return Promise.resolve('conflict');
      }
      // Every condition is checked first, then every item is written, in one step: all or none.
      const held = items.every((item, i) => (conditions[i] ?? []).every((c) => holds(partition(item.PK).get(item.SK), c)));
      if (!held) return Promise.resolve('condition_failed');
      for (const item of items) partition(item.PK).set(item.SK, clone(item));
      return Promise.resolve('ok');
    },
  };
}
