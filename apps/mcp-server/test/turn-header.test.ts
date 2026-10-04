import { ProblemDetailsSchema, TURN_HEADER, ok } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityModule } from '../src/registry.js';
import { defineTool } from '../src/tool.js';
import { TOKEN, callTool, makeHandler, post, toolResult } from './helpers.js';

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
