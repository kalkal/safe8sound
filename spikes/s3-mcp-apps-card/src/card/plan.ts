import { z } from 'zod';

// Spike-local subset of the plan_comfort output (plan §11.5); the real one lives in packages/contracts.
export const LEVELS = ['comfort', 'balanced', 'saver', 'essential'] as const;
const clock = z.string().regex(/^\d{2}:\d{2}$/);

export const PlanSchema = z.object({
  planId: z.string().min(1),
  expiresAt: z.iso.datetime(),
  goal: z.enum(['cool', 'heat', 'dry', 'auto']),
  until: clock,
  confidence: z.enum(['high', 'medium', 'low']),
  confidenceReason: z.string().min(1),
  level: z.enum(LEVELS),
  levelReason: z.enum(['weather', 'occupancy', 'user_choice', 'soc_below_track', 'storm']),
  reserveHours: z.number().nonnegative().max(48),
  guarantees: z
    .array(
      z.object({
        id: z.enum(['storm_reserve', 'pacing_on_track', 'safe_room_comfort']),
        ok: z.boolean(),
        label: z.string().min(1),
        value: z.string().min(1),
      }),
    )
    .min(1),
  dataOrigin: z.enum(['live', 'simulated']),
  storm: z.boolean(),
  stormSince: clock.optional(),
  applyAllowed: z.boolean(),
  applyBlockedReason: z.string().min(1).optional(),
});
export type Plan = z.infer<typeof PlanSchema>;
export type Level = (typeof LEVELS)[number];
