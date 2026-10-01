import type { z } from 'zod';

// Reading what is stored (audit R7, approved in #111): inputs stay strict, but a stored item may come from a
// newer version (an additive field this one does not know) or an older one. Reads drop the unknown fields
// and accept every schema version up to the current one; everything else is still checked.

const MAX_PASSES = 20;

/** A schema of something stored (any strict contract schema). */
export type StoredSchema<T> = z.ZodType<T>;

/** Parses a stored value with a strict schema, dropping the fields the schema does not know, at any depth. */
export function readStored<T>(schema: z.ZodType<T>, value: unknown): z.ZodSafeParseResult<T> {
  const current: unknown = structuredClone(value);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const parsed = schema.safeParse(current);
    if (parsed.success) return parsed;
    const unknownKeys = parsed.error.issues.filter((i) => i.code === 'unrecognized_keys');
    // Any other problem is a real one: report it as it is.
    if (unknownKeys.length === 0 || unknownKeys.length !== parsed.error.issues.length) return parsed;
    for (const issue of unknownKeys) {
      const owner = issue.path.reduce<unknown>((node, key) => (node !== null && typeof node === 'object' ? (node as Record<PropertyKey, unknown>)[key] : undefined), current);
      if (owner !== null && typeof owner === 'object') for (const key of issue.keys) Reflect.deleteProperty(owner, key);
    }
  }
  return schema.safeParse(current);
}

/** A stored item's schema version is readable when it is a positive integer up to the current one. */
export function isReadableSchemaVersion(version: unknown, current: number): boolean {
  return typeof version === 'number' && Number.isInteger(version) && version >= 1 && version <= current;
}
