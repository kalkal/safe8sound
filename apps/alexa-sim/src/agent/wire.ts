import { DataOriginSchema, IsoDateTimeSchema, PctSchema } from '@cold-reserve/contracts';
import { z } from 'zod';

// The turn protocol between alexa-sim and sim-api: POST /v1/turns.
// TODO(sim-api): move these schemas to packages/contracts when sim-api is built (maintainer decision, issue #18).

export const TurnRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(500),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

/** The facts behind a status answer: every number travels with its origin and its measurement time. */
export const StatusFactsSchema = z.strictObject({
  batterySocPct: PctSchema,
  origin: DataOriginSchema,
  ts: IsoDateTimeSchema,
});
export type StatusFacts = z.infer<typeof StatusFactsSchema>;

export const TurnReplySchema = z.strictObject({
  /** At most 2 short sentences (plan §11.2 point 10). */
  text: z.string().min(1).max(600),
  status: StatusFactsSchema.optional(),
});
export type TurnReply = z.infer<typeof TurnReplySchema>;
