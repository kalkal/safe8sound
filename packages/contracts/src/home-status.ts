import { z } from 'zod';
import { EntityIdSchema, HomeIdSchema, IsoDateTimeSchema, RoleSchema, uniqueBy } from './common.js';
import { DataOriginSchema } from './origin.js';
import { ControlAvailabilitySchema, LevelReasonSchema, LevelSchema, WaitingReasonSchema } from './pacing.js';
import { HomeLinkSchema } from './snapshot.js';
import { CelsiusSchema, PctSchema, WattSchema } from './units.js';

/** One room in `get_home_status`: the reading plus whether it is served now (plan §11.5, §11.6). */
export const HomeStatusRoomSchema = z
  .strictObject({
    roomId: EntityIdSchema,
    tempC: CelsiusSchema,
    humidityPct: PctSchema.optional(),
    /** Roles only, never names (plan §3.1). */
    occupants: z.array(RoleSchema).max(20),
    state: z.enum(['served', 'waiting']),
    waitingReason: WaitingReasonSchema.optional(),
  })
  .refine((r) => (r.state === 'waiting') === (r.waitingReason !== undefined), {
    path: ['waitingReason'],
    message: 'A waiting room needs a reason, a served room has none',
  });
export type HomeStatusRoom = z.infer<typeof HomeStatusRoomSchema>;

/** Output of the `get_home_status` MCP tool. The home comes from the caller's token, never from input. */
export const HomeStatusSchema = z.strictObject({
  homeId: HomeIdSchema,
  /** Measurement time of the snapshot behind this status. */
  ts: IsoDateTimeSchema,
  batterySocPct: PctSchema,
  pvW: WattSchema,
  loadW: WattSchema,
  /** Positive = import from the grid, negative = export. */
  gridW: WattSchema,
  gridAvailable: z.boolean(),
  level: LevelSchema,
  levelReason: LevelReasonSchema,
  levelChangedAt: IsoDateTimeSchema,
  controlAvailability: ControlAvailabilitySchema,
  rooms: z.array(HomeStatusRoomSchema).refine((rooms) => uniqueBy(rooms, (r) => r.roomId), { message: 'Room ids must be unique' }),
  /** Per field group: simulated data is never shown as live (plan §9.4). */
  origin: DataOriginSchema,
  homeLink: HomeLinkSchema,
  lastLiveAt: IsoDateTimeSchema.optional(),
});
export type HomeStatus = z.infer<typeof HomeStatusSchema>;
