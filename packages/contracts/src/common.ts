import { z } from 'zod';

/** ISO 8601 timestamp with an explicit offset (`Z` or `+02:00`). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Random, lowercase ids: never derived from an address, a name or a serial number. */
export const HomeIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9#_-]{0,63}$/)
  .brand<'HomeId'>();
export type HomeId = z.infer<typeof HomeIdSchema>;

/** The HTTP header that names a visitor sandbox home (#101): honoured only for a `<client>@demo#*` grant. */
export const HOME_HEADER = 'x-cold-reserve-home';

/** A visitor sandbox home, `demo#<16 lowercase hex>` (plan §3.2); still a HomeId. Approved in #101. */
export const SandboxHomeIdSchema = HomeIdSchema.refine((id) => /^demo#[0-9a-f]{16}$/.test(id), { message: 'Only a demo#<16 hex> sandbox home' });

export const EntityIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/** An occupant or contact role ("grandpa", "daughter"); names never reach the tools (plan §3.1). */
export const RoleSchema = z.string().regex(/^[a-z][a-z_-]{0,31}$/);

export const epochMs = (iso: string): number => Date.parse(iso);

export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}
