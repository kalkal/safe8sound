import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';
import { SandboxSettingsSchema } from './sandbox-settings.js';

// C1 (#214, approved in #214): the demo's admin config (the Regia), stored once. Structural bounds only.
// TODO(C2/R1, #214): "caps can only be lowered" — the sim-api refuses, when it writes this config, any cap above
// the ceiling deployed in its own config (e.g. global turns ≤ 100/day); on read it clamps with clampAdminCaps.

const cap = z.number().int().min(1);

export const AdminCapsSchema = z.strictObject({
  turnsPerCodePerDay: cap,
  turnsGlobalPerDay: cap,
  toolCallsPerCodePerDay: cap,
  codeAttemptsPerIpPerHour: cap,
  sandboxesPerDay: cap,
  /** Characters Polly may speak (F8d, approved in #25). */
  speechCharsPerCodePerDay: cap,
  speechCharsGlobalPerDay: cap,
});
export type AdminCaps = z.infer<typeof AdminCapsSchema>;

export const AdminSettingsSchema = z.strictObject({
  version: z.number().int().min(1),
  updatedAt: IsoDateTimeSchema,
  /** The kill switch (plan §13.2.4). */
  demoEnabled: z.boolean(),
  caps: AdminCapsSchema,
  /** What a new sandbox starts with. */
  sandboxDefaults: SandboxSettingsSchema,
});
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;

/** A stored cap never exceeds the deployed ceiling when read: each one is the lower of the two. */
export function clampAdminCaps(stored: AdminCaps, ceiling: AdminCaps): AdminCaps {
  const out = { ...stored };
  for (const key of Object.keys(ceiling) as (keyof AdminCaps)[]) out[key] = Math.min(stored[key], ceiling[key]);
  return out;
}
