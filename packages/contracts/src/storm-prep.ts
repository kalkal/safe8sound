import { z } from 'zod';
import { IsoDateTimeSchema, RoleSchema } from './common.js';

// Queue items 3 and 7 (approved in #24): the devices the house makes safe before a storm (simulated
// only; on the real home it is advice), and the family's replies from the phone. Additive, optional.

export const StormDeviceDomainSchema = z.enum(['lawn_mower', 'cover']);
export type StormDeviceDomain = z.infer<typeof StormDeviceDomainSchema>;

/**
 * A device to make safe, as a Home Assistant entity of its domain (`lawn_mower.garden`). No display name:
 * a free label from the home would reach the model, a prompt-injection vector (plan §9.2); people and
 * the model see a fixed label per domain from the i18n catalog.
 */
export const StormDeviceSchema = z
  .strictObject({
    entityId: z.string().regex(/^[a-z_]+\.[a-z0-9_]{1,40}$/),
    domain: StormDeviceDomainSchema,
  })
  .refine((d) => d.entityId.startsWith(`${d.domain}.`), { path: ['entityId'], message: 'The entity belongs to its domain' });
export type StormDevice = z.infer<typeof StormDeviceSchema>;

/** The one safe action per domain: a mower docks (lawn_mower.dock), a cover closes (cover.close_cover). */
export const SECURE_ACTION = { lawn_mower: 'dock', cover: 'close' } as const satisfies Record<StormDeviceDomain, string>;

export const DeviceSecuredSchema = z
  .strictObject({
    entityId: z.string().regex(/^[a-z_]+\.[a-z0-9_]{1,40}$/),
    domain: StormDeviceDomainSchema,
    action: z.enum(['dock', 'close']),
    outcome: z.enum(['done', 'failed']),
    at: IsoDateTimeSchema,
  })
  .refine((d) => d.action === SECURE_ACTION[d.domain], { path: ['action'], message: 'A mower docks, a cover closes' });
export type DeviceSecured = z.infer<typeof DeviceSecuredSchema>;

export const PhoneReplySchema = z.enum(['on_my_way', 'check_status']);
export type PhoneReply = z.infer<typeof PhoneReplySchema>;

/** POST /phone/reply: a closed set of replies, no free text (phone token only). */
export const PhoneReplyInputSchema = z.strictObject({ reply: PhoneReplySchema });

/** On the read-only home: what to do by hand, per device (approved in #24, Q6). No names, fixed labels. */
export const DeviceAdviceSchema = z.strictObject({ domain: StormDeviceDomainSchema, action: z.enum(['dock', 'close']) });
export type DeviceAdvice = z.infer<typeof DeviceAdviceSchema>;

/** A reply by role: the name stays on the phone. */
export const FamilyReplySchema = z.strictObject({ role: RoleSchema, reply: PhoneReplySchema, at: IsoDateTimeSchema });
export type FamilyReply = z.infer<typeof FamilyReplySchema>;
