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

export function createFakeTable(): TableClient {
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

    query: (pk, skPrefix) =>
      Promise.resolve(
        [...partition(pk)]
          .filter(([sk]) => sk.startsWith(skPrefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([, item]) => clone(item)),
      ),

    transactPut(items) {
      // No conditions are used in transactions yet, so every item is written, in one step.
      for (const item of items) partition(item.PK).set(item.SK, clone(item));
      return Promise.resolve();
    },
  };
}
