import type { ToolCard } from '@cold-reserve/contracts';
import { format } from '@cold-reserve/i18n';
import { refusalNotSaidFirst } from './evals/answer-rules.js';

// The voice and the card say the same refusal (22 Oct, the real site after #502: the card said "The safety check refused
// the proposed plan: …", the voice offered the plan as if nothing was refused). When a tool result of the turn carries the
// guard's refusal and the answer's first sentence does not name it (the eval rule refusal-not-said-first), the card's own
// sentence opens the answer, in English as every answer (the prompt asks for plain spoken English). The prompt is untouched.

/** The refusal message a plan card of the turn carries, if any. */
function refusalOf(cards: readonly ToolCard[]): string | undefined {
  for (const card of cards) {
    if (card.tool !== 'plan_comfort' || !('refusedProposal' in card.result)) continue;
    const message = card.result.refusedProposal?.message;
    if (message !== undefined) return message;
  }
  return undefined;
}

/** The answer, opened by the card's refusal sentence when it does not say it first; `prepended` says whether it changed. */
export function refusalFirst(text: string, cards: readonly ToolCard[], toolResults: readonly string[]): { text: string; prepended: boolean } {
  if (!refusalNotSaidFirst(text, toolResults)) return { text, prepended: false };
  const message = refusalOf(cards);
  // A refusal with no card that carries it: no sentence is made up.
  if (message === undefined) return { text, prepended: false };
  const sentence = format('en-US', 'plan.refusedProposal', { message });
  if (!sentence.ok) return { text, prepended: false };
  return { text: `${sentence.value} ${text}`, prepended: true };
}
