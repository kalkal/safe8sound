import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { isReadableSchemaVersion, readStored } from '../src/index.js';

// Reading what is stored (audit R7, #111): inputs stay strict, but an item written by a newer version (an extra,
// additive field) or an older one must still be readable, or a deploy would break every stored plan.

const Inner = z.strictObject({ a: z.number() });
const Outer = z.strictObject({ id: z.string(), inner: Inner, list: z.array(Inner) }).refine((o) => o.id !== 'bad', { message: 'no bad ids' });

describe('readStored', () => {
  it('drops fields it does not know, at any depth, and keeps the rest', () => {
    const r = readStored(Outer, { id: 'x', extra: 1, inner: { a: 1, added: true }, list: [{ a: 2, later: 'y' }] });
    expect(r.success && r.data).toEqual({ id: 'x', inner: { a: 1 }, list: [{ a: 2 }] });
  });

  it('still refuses what is wrong, and keeps the refinements', () => {
    expect(readStored(Outer, { id: 'x', inner: { a: 'one' }, list: [] }).success).toBe(false);
    expect(readStored(Outer, { id: 'bad', inner: { a: 1 }, list: [], extra: 1 }).success).toBe(false);
  });

  it('leaves the strict schema strict for inputs', () => {
    expect(Outer.safeParse({ id: 'x', extra: 1, inner: { a: 1 }, list: [] }).success).toBe(false);
  });
});

describe('isReadableSchemaVersion', () => {
  it('reads the current version and every older one, never a newer one', () => {
    expect(isReadableSchemaVersion(1, 2)).toBe(true);
    expect(isReadableSchemaVersion(2, 2)).toBe(true);
    expect(isReadableSchemaVersion(3, 2)).toBe(false);
    expect(isReadableSchemaVersion(0, 2)).toBe(false);
    expect(isReadableSchemaVersion('1', 2)).toBe(false);
  });
});
