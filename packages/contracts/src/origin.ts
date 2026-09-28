import { z } from 'zod';

// Where the data comes from, per field group (plan §9.4, main decision 2026-09-28):
// "real SOC, scenario weather" must be expressible, and simulated data is never shown as real.

export const DataOriginValueSchema = z.enum(['live', 'simulated']);
export type DataOriginValue = z.infer<typeof DataOriginValueSchema>;

export const DATA_GROUPS = ['energy', 'rooms', 'weather'] as const;
export type DataGroup = (typeof DATA_GROUPS)[number];

export const DataOriginSchema = z
  .strictObject({
    energy: DataOriginValueSchema,
    rooms: DataOriginValueSchema,
    weather: DataOriginValueSchema,
    /** Scenario name (drives the SCENARIO badge); present only when some group is simulated. */
    scenario: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,47}$/)
      .optional(),
  })
  .refine((o) => o.scenario === undefined || DATA_GROUPS.some((g) => o[g] === 'simulated'), {
    path: ['scenario'],
    message: 'A scenario implies at least one simulated group',
  });
export type DataOrigin = z.infer<typeof DataOriginSchema>;

/** True when every group the caller depends on is live (a plan is "live" only then). */
export const isFullyLive = (origin: DataOrigin, groups: readonly DataGroup[] = DATA_GROUPS): boolean =>
  groups.every((g) => origin[g] === 'live');
