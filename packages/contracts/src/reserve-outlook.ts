import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';
import { DataOriginSchema } from './origin.js';
import { LevelSchema } from './pacing.js';

// The reserve counted in hours (plan §11.1 signature: one ice cube = one hour at the current level;
// §11.2 p.3 and p.14: reserve and autonomy in comfort hours). Added 2026-09-29, approved in #21.

const hours = z.number().nonnegative();

export const ReserveOutlookSchema = z
  .strictObject({
    /** The pacing level the hours are counted at. */
    level: LevelSchema,
    /** On the battery alone at the current level: one ice cube per hour. */
    hoursAtCurrentLevel: hours,
    /** The same energy at Essential, the most frugal level. */
    hoursAtEssential: hours,
    /** The storm reserve alone, at Essential: what the reserve buys when the grid is lost. */
    reserveHoursAtEssential: hours,
    /**
     * Whether the grid was up when the hours were counted: false in a storm, when the cards switch to the
     * storm theme (optional, added 2026-09-30, approved in #21; same meaning as Plan.gridAvailable).
     */
    gridAvailable: z.boolean().optional(),
    /** Per field group: simulated data is never shown as live (plan §9.4). */
    origin: DataOriginSchema,
    /** Measurement time of the snapshot behind the hours. */
    ts: IsoDateTimeSchema,
  })
  .refine((o) => o.hoursAtEssential >= o.hoursAtCurrentLevel, {
    path: ['hoursAtEssential'],
    message: 'Essential is the most frugal level: it never lasts less than the current one',
  });
export type ReserveOutlook = z.infer<typeof ReserveOutlookSchema>;
