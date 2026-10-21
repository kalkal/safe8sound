import { describe, expect, it } from 'vitest';
import { ACTION_CONTEXT_KEY, actionOfContext, canAct } from '../src/card-action.js';

describe('actionOfContext: the host says where the action of a card stands (one message)', () => {
  it('reads busy, applied (with its time when known) and expired', () => {
    expect(actionOfContext({ [ACTION_CONTEXT_KEY]: { phase: 'busy' } })).toEqual({ phase: 'busy' });
    expect(actionOfContext({ [ACTION_CONTEXT_KEY]: { phase: 'applied', at: '2026-07-15T14:05:00+02:00' } })).toEqual({ phase: 'applied', at: '2026-07-15T14:05:00+02:00' });
    expect(actionOfContext({ [ACTION_CONTEXT_KEY]: { phase: 'applied' } })).toEqual({ phase: 'applied' });
    expect(actionOfContext({ [ACTION_CONTEXT_KEY]: { phase: 'expired' } })).toEqual({ phase: 'expired' });
  });

  it('a host that says nothing (a real Alexa+ device), or something else, leaves the card ready', () => {
    expect(actionOfContext(undefined)).toEqual({ phase: 'ready' });
    expect(actionOfContext({})).toEqual({ phase: 'ready' });
    expect(actionOfContext({ [ACTION_CONTEXT_KEY]: { phase: 'done' } })).toEqual({ phase: 'ready' });
    expect(actionOfContext({ [ACTION_CONTEXT_KEY]: { phase: 'applied', at: 'yesterday' } })).toEqual({ phase: 'ready' });
  });

  it('only a ready card has something to do', () => {
    expect(canAct({ phase: 'ready' })).toBe(true);
    for (const phase of ['busy', 'applied', 'expired'] as const) expect(canAct({ phase })).toBe(false);
  });
});
