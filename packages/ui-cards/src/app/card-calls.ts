import { t } from '../text.js';
import { parseCardResult, parseSaveResult, type CardState, type ToolResultLike } from './card-kinds.js';

// What a card shows once the host answered one of its calls, or never did. Pure code, unit tested; main.tsx wires it.
// A failed call never turns the card into an error: it keeps its buttons and says in one line what went wrong.

export interface CardNotice {
  ok: boolean;
  text: string;
}

export interface AfterCall {
  state: CardState;
  notice?: CardNotice;
}

/** `result` undefined: the call got no answer (the bridge failed or timed out); the same tap can be tried again. */
export function afterCall(state: CardState, name: string, result: ToolResultLike | undefined): AfterCall {
  if (result === undefined) return { state, notice: { ok: false, text: t('card.noAnswer') } };
  if (name === 'apply_plan') {
    // Apply turns this frame into the applied plan; a refusal (expired, not allowed) is said above the plan.
    const next = parseCardResult('applied', result);
    if (next.kind === 'applied') return { state: { ...next, fromThisFrame: true } };
    return { state, notice: { ok: false, text: next.kind === 'error' ? next.message : t('card.failed') } };
  }
  if (name === 'set_preferences') {
    // Save says whether it worked and shows the new values; a refused save keeps the draft (the card stays as it is).
    const saved = parseSaveResult(result);
    if (!saved.ok) return { state, notice: { ok: false, text: saved.error } };
    const next = state.kind === 'preferences' ? { ...state, data: { ...state.data, preferences: saved.value } } : state;
    return { state: next, notice: { ok: true, text: t('prefs.saved') } };
  }
  return { state };
}
