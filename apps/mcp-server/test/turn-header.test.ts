import { HomeIdSchema, ProblemDetailsSchema, TURN_HEADER, ok } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityModule } from '../src/registry.js';
import { defineTool } from '../src/tool.js';
import { TOKEN, callTool, initializeRequest, makeHandler, post, toolResult, toolsList } from './helpers.js';

// The turn header (#230): the agent names the turn of every MCP call; the tools read it from the context.

const turnProbe: CapabilityModule = {
  id: 'turn-probe',
  tools: [
    defineTool({
      name: 'which_turn',
      title: 'Which turn',
      description: 'Test-only: returns the turn of the call.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      input: z.strictObject({}),
      output: z.strictObject({ turnId: z.string().nullable() }),
      handler: (_args, ctx) => Promise.resolve(ok({ turnId: ctx.turnId ?? null })),
    }),
  ],
};

const TURN = '3f6c1a9e-8b2d-4c7e-9a1f-2b3c4d5e6f70';

describe(`${TURN_HEADER}: the turn of an MCP call (#230)`, () => {
  const { handler } = makeHandler({ modules: [turnProbe] });
  const ask = (turn?: string) => post(handler, callTool('which_turn', {}), { authorization: `Bearer ${TOKEN}`, [TURN_HEADER]: turn });

  it('reaches the tool when the caller sends it', async () => {
    expect((await toolResult(await ask(TURN))).structuredContent).toEqual({ turnId: TURN });
  });

  it('is absent for a call without it (a card tap)', async () => {
    expect((await toolResult(await ask())).structuredContent).toEqual({ turnId: null });
  });

  it('a malformed one is refused with 400 invalid_input', async () => {
    const res = await ask('turn-1');
    expect(res.status).toBe(400);
    expect(ProblemDetailsSchema.parse(await res.json()).code).toBe('invalid_input');
  });
});

// #233: the agent and the card actions have tokens of their own. The agent's tool calls always name their turn, so
// it can never pass for the person's tap; a card action never names one, so it can never pass for a turn.
describe('scoped clients: the agent always names its turn, a card action never does (#233)', () => {
  const AGENT_TOKEN = 'g'.repeat(32);
  const CARDS_TOKEN = 'c'.repeat(32);
  const { handler, logs } = makeHandler({
    modules: [turnProbe],
    config: {
      clients: new Map([
        [TOKEN, { clientId: 'bench', homeId: HomeIdSchema.parse('demo') }],
        [AGENT_TOKEN, { clientId: 'agent', homeId: HomeIdSchema.parse('demo'), scope: 'agent' }],
        [CARDS_TOKEN, { clientId: 'sim', homeId: HomeIdSchema.parse('demo'), scope: 'cards' }],
      ]),
    },
  });
  const as = (token: string, turn?: string, body: unknown = callTool('which_turn', {})) => post(handler, body, { authorization: `Bearer ${token}`, [TURN_HEADER]: turn });

  it("refuses the agent's tool call without a turn (400), and serves it with one", async () => {
    const res = await as(AGENT_TOKEN);
    expect(res.status).toBe(400);
    expect(ProblemDetailsSchema.parse(await res.json())).toMatchObject({ code: 'invalid_input' });
    expect(logs.some((l) => l.code === 'invalid_input' && l.clientId === 'agent')).toBe(true);
    expect((await toolResult(await as(AGENT_TOKEN, TURN))).structuredContent).toEqual({ turnId: TURN });
  });

  it('lets the agent open its session and list the tools without a turn: only tool calls name one', async () => {
    expect((await as(AGENT_TOKEN, undefined, initializeRequest)).status).toBe(200);
    expect((await as(AGENT_TOKEN, undefined, toolsList)).status).toBe(200);
  });

  it('refuses a card action that names a turn (400), and serves it without one', async () => {
    const res = await as(CARDS_TOKEN, TURN);
    expect(res.status).toBe(400);
    expect(ProblemDetailsSchema.parse(await res.json())).toMatchObject({ code: 'invalid_input' });
    expect((await toolResult(await as(CARDS_TOKEN))).structuredContent).toEqual({ turnId: null });
  });

  it('treats a JSON-RPC batch that holds a tool call as a tool call: the agent cannot skip its turn that way (#245 review)', async () => {
    const batch = [toolsList, callTool('which_turn', {})];
    const res = await as(AGENT_TOKEN, undefined, batch);
    expect(res.status).toBe(400);
    expect(ProblemDetailsSchema.parse(await res.json())).toMatchObject({ code: 'invalid_input' });
    expect(logs.some((l) => l.details?.['event'] === 'agent_call_without_turn')).toBe(true);
    // A batch without any tool call opens nothing: it passes the turn rule (the transport answers it as it does).
    expect((await as(AGENT_TOKEN, undefined, [toolsList])).status).not.toBe(400);
  });

  it('refuses a card action batch that names a turn, like a single request', async () => {
    const res = await as(CARDS_TOKEN, TURN, [callTool('which_turn', {})]);
    expect(res.status).toBe(400);
  });

  it('keeps an unscoped client as before: with or without a turn (the accepted risk)', async () => {
    expect((await toolResult(await as(TOKEN))).structuredContent).toEqual({ turnId: null });
    expect((await toolResult(await as(TOKEN, TURN))).structuredContent).toEqual({ turnId: TURN });
  });
});
