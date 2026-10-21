import { IsoDateTimeSchema } from '@cold-reserve/contracts';
import { z } from 'zod';

// Where a card's action stands, told by the host through its own hostContext key (MCP Apps allows extra keys), one
// message: a card keeps no busy or applied state of its own, so a card shown again (Previous) knows its plan is
// applied, and Apply, Not now and Save are off while a call is on its way. The server's idempotency stays the real
// barrier; this only keeps the card honest. A host that says nothing (a real Alexa+ device) leaves the card ready.

/** The hostContext key the simulator sets for each frame. */
export const ACTION_CONTEXT_KEY = 'coldReserveAction';

const CardActionSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('ready') }),
  /** A call of this card is on its way. */
  z.strictObject({ phase: z.literal('busy') }),
  /** Its plan was applied from this card; `at` on the home's simulated clock, when the host knows it. */
  z.strictObject({ phase: z.literal('applied'), at: IsoDateTimeSchema.optional() }),
  /** Its plan (or its last-resort confirmation) can no longer be applied: ask for a new one. */
  z.strictObject({ phase: z.literal('expired') }),
]);
export type CardAction = z.infer<typeof CardActionSchema>;

// An unknown or malformed message fails open to ready, on purpose: host and cards ship together in one build, and the
// server's idempotency (alreadyApplied, plan_expired) is the barrier, never this message.
const READY: CardAction = { phase: 'ready' };

/** The action in a host context; ready when the host names none (or something else). */
export function actionOfContext(context: Readonly<Record<string, unknown>> | undefined): CardAction {
  const parsed = CardActionSchema.safeParse(context?.[ACTION_CONTEXT_KEY]);
  return parsed.success ? parsed.data : READY;
}

/** A command with nothing to do is off: only a ready card may call a tool. */
export const canAct = (action: CardAction): boolean => action.phase === 'ready';
