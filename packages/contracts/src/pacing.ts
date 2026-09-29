import { z } from 'zod';
import { EntityIdSchema, IsoDateTimeSchema } from './common.js';

/** Pacing levels from the most to the least comfortable (plan §4bis). */
export const LEVELS = ['comfort', 'balanced', 'saver', 'essential'] as const;
export const LevelSchema = z.enum(LEVELS);
export type Level = z.infer<typeof LevelSchema>;

export const levelRank = (level: Level): number => LEVELS.indexOf(level);

/** Why the level is what it is (plan §11.5): every change is explained. */
/** `soc_above_track` added 2026-09-29 (additive, approved in #57): a step back up has its own reason. */
export const LevelReasonSchema = z.enum(['weather', 'occupancy', 'user_choice', 'soc_below_track', 'soc_above_track', 'storm']);
export type LevelReason = z.infer<typeof LevelReasonSchema>;

export const PacingStateSchema = z.strictObject({
  level: LevelSchema,
  levelReason: LevelReasonSchema,
  levelChangedAt: IsoDateTimeSchema,
});
export type PacingState = z.infer<typeof PacingStateSchema>;

export const SeasonSchema = z.enum(['cooling', 'heating', 'neutral']);
export type Season = z.infer<typeof SeasonSchema>;

/** Whether the splits can be driven right now (plan §11.5). */
export const ControlAvailabilitySchema = z.enum(['ok', 'cloud_unreachable', 'manual_only']);
export type ControlAvailability = z.infer<typeof ControlAvailabilitySchema>;

export const WaitingReasonSchema = z.enum(['inverter_limit', 'pacing_level', 'user_off']);
export type WaitingReason = z.infer<typeof WaitingReasonSchema>;

/** Per room: served now, or waiting with the reason (thermal floor plan, plan §11.6). */
export const RoomServiceSchema = z
  .strictObject({
    roomId: EntityIdSchema,
    state: z.enum(['served', 'waiting']),
    waitingReason: WaitingReasonSchema.optional(),
  })
  .refine((r) => (r.state === 'waiting') === (r.waitingReason !== undefined), {
    path: ['waitingReason'],
    message: 'A waiting room needs a reason, a served room has none',
  });
export type RoomService = z.infer<typeof RoomServiceSchema>;
