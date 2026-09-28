import { describe, expect, it } from 'vitest';
import { PlanSchema } from '../src/card/plan.js';
import { CARD_MIME_TYPE, PLAN_CARD_URI } from '../src/server/card-resource.js';
import { createCardServer, type LogEntry } from '../src/server/handler.js';
import { ToolErrorSchema } from '../src/server/tool-error.js';

const ASSETS = { tokensCss: '@layer tokens { :root { --surface-card: red; } }', cardCss: '@layer components { .card { } }', cardJs: 'console.log("card")' };

function makeServer(loadAssets: () => Promise<typeof ASSETS> = async () => ASSETS) {
  const logs: LogEntry[] = [];
  const handler = createCardServer({ loadAssets, logger: { log: (e) => logs.push(e) } });
  return { handler, logs };
}

async function rpc(handler: (req: Request) => Promise<Response>, method: string, params: unknown = {}) {
  const res = await handler(
    new Request('http://127.0.0.1:3100/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: any; error?: { code: number; message: string } };
}

describe('initialize', () => {
  it('advertises tools and resources', async () => {
    const { handler } = makeServer();
    const body = await rpc(handler, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'unit', version: '0' },
    });
    expect(body.result.capabilities).toMatchObject({ tools: {}, resources: {} });
  });
});

describe('resources', () => {
  it('lists the plan card as an MCP App resource', async () => {
    const { handler } = makeServer();
    const body = await rpc(handler, 'resources/list');
    expect(body.result.resources).toContainEqual(expect.objectContaining({ uri: PLAN_CARD_URI, mimeType: CARD_MIME_TYPE }));
    expect(PLAN_CARD_URI).toBe('ui://cold-reserve/plan-card');
    expect(CARD_MIME_TYPE).toBe('text/html;profile=mcp-app');
  });

  it('reads the card as one self-contained HTML document with tokens, css and script inlined', async () => {
    const { handler } = makeServer();
    const body = await rpc(handler, 'resources/read', { uri: PLAN_CARD_URI });
    const [content] = body.result.contents;
    expect(content).toMatchObject({ uri: PLAN_CARD_URI, mimeType: CARD_MIME_TYPE });
    const html: string = content.text;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en" data-card-theme="pawnio-dark">');
    expect(html).toContain('@layer reset, tokens, base, components, surfaces, overrides;');
    expect(html).toContain(ASSETS.tokensCss);
    expect(html).toContain(ASSETS.cardCss);
    expect(html).toContain(ASSETS.cardJs);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });

  it('declares an empty network CSP in the resource _meta.ui (no external domains)', async () => {
    const { handler } = makeServer();
    const body = await rpc(handler, 'resources/read', { uri: PLAN_CARD_URI });
    expect(body.result.contents[0]._meta.ui).toMatchObject({ csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false });
  });

  it('escapes a closing script tag in the bundle so it cannot break out of the inline script', async () => {
    const { handler } = makeServer(async () => ({ ...ASSETS, cardJs: 'const s = "</script><img src=x>";' }));
    const body = await rpc(handler, 'resources/read', { uri: PLAN_CARD_URI });
    const html: string = body.result.contents[0].text;
    expect(html).not.toContain('</script><img');
    expect(html).toContain('<\\/script><img');
  });

  it('answers an unknown ui:// resource with the JSON-RPC resource-not-found error', async () => {
    const { handler } = makeServer();
    const body = await rpc(handler, 'resources/read', { uri: 'ui://cold-reserve/nope' });
    expect(body.error?.code).toBe(-32002);
  });

  it('answers missing card assets with an internal error and logs it once', async () => {
    const { handler, logs } = makeServer(async () => {
      throw new Error('ENOENT dist/card/card.js');
    });
    const body = await rpc(handler, 'resources/read', { uri: PLAN_CARD_URI });
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).not.toContain('ENOENT');
    expect(logs).toEqual([expect.objectContaining({ code: 'card_assets_unavailable', category: 'internal' })]);
  });
});

describe('plan_comfort tool', () => {
  it('links the tool to the card through _meta.ui.resourceUri and advertises anyOf [plan, error]', async () => {
    const { handler } = makeServer();
    const body = await rpc(handler, 'tools/list');
    const tool = body.result.tools.find((t: { name: string }) => t.name === 'plan_comfort');
    expect(tool._meta.ui.resourceUri).toBe(PLAN_CARD_URI);
    expect(tool._meta['ui/resourceUri']).toBe(PLAN_CARD_URI);
    expect(tool.outputSchema.anyOf).toHaveLength(2);
  });

  it('returns a valid plan for the hot-day scenario', async () => {
    const { handler } = makeServer();
    const body = await rpc(handler, 'tools/call', { name: 'plan_comfort', arguments: { scenario: 'hot-day' } });
    expect(body.result.isError).toBeFalsy();
    const plan = PlanSchema.parse(body.result.structuredContent);
    expect(plan.storm).toBe(false);
    expect(body.result.content[0].text.length).toBeGreaterThan(0);
  });

  it('returns a storm plan with Apply blocked and its reason', async () => {
    const { handler } = makeServer();
    const body = await rpc(handler, 'tools/call', { name: 'plan_comfort', arguments: { scenario: 'storm' } });
    const plan = PlanSchema.parse(body.result.structuredContent);
    expect(plan).toMatchObject({ storm: true, applyAllowed: false });
    expect(plan.applyBlockedReason).toBeTruthy();
  });

  it('returns isError + home_data_stale (retryable) when the home cannot be read', async () => {
    const { handler, logs } = makeServer();
    const body = await rpc(handler, 'tools/call', { name: 'plan_comfort', arguments: { scenario: 'home-unreachable' } });
    expect(body.result.isError).toBe(true);
    expect(ToolErrorSchema.parse(body.result.structuredContent)).toMatchObject({
      code: 'home_data_stale',
      category: 'dependency_unavailable',
      retryable: true,
    });
    expect(logs.map((l) => l.code)).toEqual(['home_data_stale']);
  });

  it('returns isError + invalid_arguments for an unknown scenario', async () => {
    const { handler } = makeServer();
    const body = await rpc(handler, 'tools/call', { name: 'plan_comfort', arguments: { scenario: 'volcano' } });
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toMatchObject({ code: 'invalid_arguments', category: 'validation' });
  });

  it('answers an unknown tool with JSON-RPC -32602', async () => {
    const { handler } = makeServer();
    const body = await rpc(handler, 'tools/call', { name: 'nope', arguments: {} });
    expect(body.error?.code).toBe(-32602);
  });
});
