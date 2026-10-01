import { ToolCardSchema, type ToolCard } from '@cold-reserve/contracts';
import { log as defaultLog, type Log } from '../log.js';

// The turn protocol between alexa-sim and sim-api lives in @cold-reserve/contracts (#55):
// one schema for both apps. Only the per-card reading, with its log line, stays here.
export {
  StatusFactsSchema,
  ToolCardSchema,
  TurnReplySchema,
  TurnRequestSchema,
  type CardToolName as ToolName,
  type StatusFacts,
  type ToolCard,
  type TurnReply,
  type TurnRequest,
} from '@cold-reserve/contracts';

/** A card slot: a valid tool result, or one that broke its contract and is shown as a calm failure. */
export type CardSlot = ToolCard | { tool: 'invalid' };

/** One bad card never costs the answer or the other cards (error-handling §3). */
export function readCards(cards: readonly unknown[] | undefined, { correlationId, log = defaultLog }: { correlationId?: string; log?: Log } = {}): CardSlot[] | undefined {
  return cards?.map((card) => {
    const parsed = ToolCardSchema.safeParse(card);
    if (parsed.success) return parsed.data;
    log({ level: 'warn', code: 'output_schema_violation', ...(correlationId !== undefined && { correlationId }), details: { issues: parsed.error.issues.length } });
    return { tool: 'invalid' as const };
  });
}
