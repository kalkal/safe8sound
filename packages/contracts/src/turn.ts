import { z } from 'zod';
import { ApplyPlanInputSchema, ApplyPlanOutputSchema } from './comfort-plan.js';
import { IsoDateTimeSchema } from './common.js';
import { ErrorCategorySchema, ErrorCodeSchema, categoryOf } from './errors.js';
import { DataOriginSchema } from './origin.js';
import { PlanSchema } from './plan.js';
import { GetPreferencesOutputSchema, SetPreferencesInputSchema } from './preferences-view.js';
import { ReserveOutlookSchema } from './reserve-outlook.js';
import { HomeStatusSchema } from './home-status.js';
import { SafeRoomStatusSchema } from './storm.js';
import { PctSchema } from './units.js';

// The wire between alexa-sim and sim-api (#55, #101). The browser only ever holds the demo token:
// the home comes from it server-side, never from these bodies (closed objects).

/** POST /v1/session: a demo code for a short-lived signed token (plan §13.2 point 2). */
export const SessionRequestSchema = z.strictObject({ code: z.string().min(16).max(128) });
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

export const SessionReplySchema = z.strictObject({ token: z.string().min(1).max(2048), expiresAt: IsoDateTimeSchema });
export type SessionReply = z.infer<typeof SessionReplySchema>;

/** POST /v1/turns */
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

/** A tool result the answer shows as a card: the MCP structuredContent, validated by its contract. */
export const ToolCardSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('plan_comfort'), result: PlanSchema }),
  z.strictObject({ tool: z.literal('apply_plan'), result: ApplyPlanOutputSchema }),
  z.strictObject({ tool: z.literal('get_reserve_outlook'), result: ReserveOutlookSchema }),
  z.strictObject({ tool: z.literal('get_preferences'), result: GetPreferencesOutputSchema }),
  /** The storm card (safe room), additive, approved in #24 (Q2). */
  z.strictObject({ tool: z.literal('get_safe_room_status'), result: SafeRoomStatusSchema }),
  /** The thermal floor plan (plan §11.6), additive, approved in #24 (Q2). */
  z.strictObject({ tool: z.literal('get_home_status'), result: HomeStatusSchema }),
]);
export type ToolCard = z.infer<typeof ToolCardSchema>;
export type CardToolName = ToolCard['tool'];

export const TurnReplySchema = z.strictObject({
  /** At most 2 short sentences (plan §11.2 point 10). */
  text: z.string().min(1).max(600),
  status: StatusFactsSchema.optional(),
  /** Inline cards, in the order the answer mentions them: each is validated on its own (one bad card never costs the answer). */
  cards: z.array(z.unknown()).max(4).optional(),
});
export type TurnReply = z.infer<typeof TurnReplySchema>;

/**
 * An expected turn failure, as the agent answers it on AgentCore (#17, G1c, approved in #17): HTTP 200
 * with this envelope, because AgentCore turns any 4xx/5xx of the container into a 424 for the caller and
 * the code would be lost. The code and its category, the wait time and the turn id; never free text.
 * sim-api turns it back into Problem Details with the same category.
 */
export const TurnFailureSchema = z
  .strictObject({
    failed: z.literal(true),
    code: ErrorCodeSchema,
    category: ErrorCategorySchema,
    retryAfterMs: z.number().int().nonnegative().optional(),
    correlationId: z.string().min(1).max(128),
  })
  .refine((f) => categoryOf(f.code) === f.category, { message: 'The category is the one the catalogue gives the code', path: ['category'] });
export type TurnFailure = z.infer<typeof TurnFailureSchema>;

/** POST /v1/tools/call: a card action, already bound to its card by the host. Only these two exist. */
export const ToolCallRequestSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('apply_plan'), arguments: ApplyPlanInputSchema }),
  z.strictObject({ name: z.literal('set_preferences'), arguments: SetPreferencesInputSchema }),
]);
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

/** The MCP CallToolResult a card receives: tool errors are values (isError + the error envelope). */
export const ToolCallReplySchema = z.strictObject({
  isError: z.boolean().optional(),
  content: z.array(z.strictObject({ type: z.literal('text'), text: z.string() })).min(1),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
export type ToolCallReply = z.infer<typeof ToolCallReplySchema>;
