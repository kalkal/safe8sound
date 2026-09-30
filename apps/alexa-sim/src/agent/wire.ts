import {
  ApplyPlanOutputSchema,
  DataOriginSchema,
  GetPreferencesOutputSchema,
  IsoDateTimeSchema,
  PctSchema,
  PlanSchema,
  ReserveOutlookSchema,
} from '@cold-reserve/contracts';
import { z } from 'zod';

// The turn protocol between alexa-sim and sim-api: POST /v1/turns.
// TODO(sim-api, #55): move these schemas to packages/contracts when sim-api is built.

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
]);
export type ToolCard = z.infer<typeof ToolCardSchema>;
export type ToolName = ToolCard['tool'];

export const TurnReplySchema = z.strictObject({
  /** At most 2 short sentences (plan §11.2 point 10). */
  text: z.string().min(1).max(600),
  status: StatusFactsSchema.optional(),
  /** Inline cards, in the order the answer mentions them: each is validated on its own by readCards. */
  cards: z.array(z.unknown()).max(4).optional(),
});

/** A card slot: a valid tool result, or one that broke its contract and is shown as a calm failure. */
export type CardSlot = ToolCard | { tool: 'invalid' };

/** One bad card never costs the answer or the other cards (error-handling §3). */
export function readCards(cards: readonly unknown[] | undefined): CardSlot[] | undefined {
  return cards?.map((card) => {
    const parsed = ToolCardSchema.safeParse(card);
    if (parsed.success) return parsed.data;
    console.warn(JSON.stringify({ level: 'warn', component: 'alexa-sim', code: 'output_schema_violation', issues: parsed.error.issues.length }));
    return { tool: 'invalid' as const };
  });
}
export type TurnReply = z.infer<typeof TurnReplySchema>;
