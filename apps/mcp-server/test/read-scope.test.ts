import { HomeIdSchema, ProblemDetailsSchema, ok } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import type { CapabilityModule } from '../src/registry.js';
import { defineTool } from '../src/tool.js';
import { TOKEN, callTool, initializeRequest, makeHandler, post, toolResult, toolsList } from './helpers.js';

// #26: the classic Alexa skill holds a `read:` token. It may call the three read tools and nothing else, so a leaked
// skill token can never change the home. The allow list is written by hand (READ_SCOPE_TOOLS), never derived.

const probe = (name: string) =>
  defineTool({
    name,
    title: name,
    description: 'Test-only: says its own name.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: z.strictObject({}),
    output: z.strictObject({ tool: z.string() }),
    handler: () => Promise.resolve(ok({ tool: name })),
  });
const tools: CapabilityModule = { id: 'read-scope-probe', tools: ['get_home_status', 'get_reserve_outlook', 'get_safe_room_status', 'apply_plan'].map(probe) };

const READ_TOKEN = 'r'.repeat(32);
const { handler, logs } = makeHandler({
  modules: [tools],
  config: {
    clients: new Map([
      [TOKEN, { clientId: 'bench', homeId: HomeIdSchema.parse('demo') }],
      [READ_TOKEN, { clientId: 'alexa', homeId: HomeIdSchema.parse('demo'), scope: 'read' }],
    ]),
  },
});
const as = (token: string, body: unknown) => post(handler, body, { authorization: `Bearer ${token}` });

describe('read-scoped clients (#26)', () => {
  it('parse from MCP_CLIENTS as read:<client>@<homeId>=<token>', () => {
    const result = loadConfig({ MCP_CLIENTS: `read:alexa@demo=${READ_TOKEN}` });
    expect(result.ok && result.value.clients.get(READ_TOKEN)).toEqual({ clientId: 'alexa', homeId: 'demo', scope: 'read' });
  });

  it('call each of the three read tools', async () => {
    for (const name of ['get_home_status', 'get_reserve_outlook', 'get_safe_room_status']) {
      expect((await toolResult(await as(READ_TOKEN, callTool(name, {})))).structuredContent).toEqual({ tool: name });
    }
  });

  it('are refused any other tool with wrong_client, and the refusal is logged', async () => {
    const res = await as(READ_TOKEN, callTool('apply_plan', {}));
    expect(res.status).toBe(401);
    expect(ProblemDetailsSchema.parse(await res.json())).toMatchObject({ code: 'wrong_client' });
    expect(logs.some((l) => l.clientId === 'alexa' && l.details?.['event'] === 'read_client_call_refused')).toBe(true);
  });

  it('cannot slip a write into a batch, nor call a tool without a name', async () => {
    expect((await as(READ_TOKEN, [callTool('get_home_status', {}, 1), callTool('apply_plan', {}, 2)])).status).toBe(401);
    expect((await as(READ_TOKEN, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })).status).toBe(401);
  });

  it('still open a session and list tools; an unscoped client keeps every tool', async () => {
    expect((await as(READ_TOKEN, initializeRequest)).status).toBe(200);
    expect((await as(READ_TOKEN, toolsList)).status).toBe(200);
    expect((await toolResult(await as(TOKEN, callTool('apply_plan', {})))).structuredContent).toEqual({ tool: 'apply_plan' });
  });
});
