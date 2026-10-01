import { err, ok, toolError } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import type { CapabilityModule } from '../src/registry.js';
import { HOME_TOKEN, makeHandler, post, probeModule, toolsList } from './helpers.js';

// MCP Apps on the server (#92): the cards as ui:// resources, linked from their tools.

const PLAN_URI = 'ui://cold-reserve/plan-card';
const BROKEN_URI = 'ui://cold-reserve/broken';
const HTML = '<!doctype html><html><head></head><body></body></html>';

const [whoami] = probeModule.tools;
if (whoami === undefined) throw new Error('probe module without tools');

const cards: CapabilityModule = {
  id: 'cards',
  tools: [{ ...whoami, ui: { resourceUri: PLAN_URI } }],
  resources: [
    { uri: PLAN_URI, name: 'plan-card', title: 'Plan card', description: 'The hot-day plan.', read: () => ok(HTML) },
    {
      uri: BROKEN_URI,
      name: 'broken',
      title: 'Broken card',
      description: 'Its document cannot be built.',
      read: () => err(toolError('invalid_config', 'The card bundle is not built.')),
    },
  ],
};
const homeOff: CapabilityModule = { ...cards, id: 'home-off', tools: [], enabledFor: (h) => h !== 'home' };

const listResources = { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} };
const readResource = (uri: string) => ({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri } });

interface Rpc<T> {
  result?: T;
  error?: { code: number; message: string };
}
const rpc = async <T>(res: Response) => (await res.json()) as Rpc<T>;

describe('tools/list links each card tool to its ui:// resource', () => {
  it('sets _meta.ui.resourceUri (and the legacy ui/resourceUri key) only on tools with a card', async () => {
    const { handler } = makeHandler({ modules: [cards, { ...probeModule, tools: probeModule.tools.slice(1) }] });
    const body = await rpc<{ tools: { name: string; _meta?: Record<string, unknown> }[] }>(await post(handler, toolsList));
    const [linked, ...others] = body.result?.tools ?? [];
    expect(linked).toMatchObject({ name: 'whoami', _meta: { ui: { resourceUri: PLAN_URI }, 'ui/resourceUri': PLAN_URI } });
    for (const tool of others) expect(tool).not.toHaveProperty('_meta');
  });
});

describe('resources/list', () => {
  it('lists every card as an MCP Apps document', async () => {
    const { handler } = makeHandler({ modules: [cards] });
    const body = await rpc<{ resources: unknown[] }>(await post(handler, listResources));
    expect(body.result?.resources).toEqual([
      { uri: PLAN_URI, name: 'plan-card', title: 'Plan card', description: 'The hot-day plan.', mimeType: 'text/html;profile=mcp-app' },
      { uri: BROKEN_URI, name: 'broken', title: 'Broken card', description: 'Its document cannot be built.', mimeType: 'text/html;profile=mcp-app' },
    ]);
  });

  it('hides the cards of a module switched off for the caller home', async () => {
    const { handler } = makeHandler({ modules: [{ ...homeOff, tools: probeModule.tools }] });
    const body = await rpc<{ resources: unknown[] }>(await post(handler, listResources, { authorization: `Bearer ${HOME_TOKEN}` }));
    expect(body.result?.resources).toEqual([]);
  });

  it('is an empty list on a server without cards', async () => {
    const { handler } = makeHandler();
    expect((await rpc<{ resources: unknown[] }>(await post(handler, listResources))).result?.resources).toEqual([]);
  });
});

describe('resources/read', () => {
  it('serves the document with the mime type and a CSP that allows no domain at all', async () => {
    const { handler } = makeHandler({ modules: [cards] });
    const body = await rpc<{ contents: unknown[] }>(await post(handler, readResource(PLAN_URI)));
    expect(body.result?.contents).toEqual([
      { uri: PLAN_URI, mimeType: 'text/html;profile=mcp-app', text: HTML, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } },
    ]);
  });

  it('answers an unknown uri with the MCP "resource not found" error (-32002)', async () => {
    const { handler } = makeHandler({ modules: [cards] });
    const body = await rpc(await post(handler, readResource('ui://cold-reserve/nope')));
    expect(body.error?.code).toBe(-32002);
    expect(body.error?.message).toContain('Resource not found: ui://cold-reserve/nope');
  });

  it('treats the card of a module switched off for the caller home as not found', async () => {
    const { handler } = makeHandler({ modules: [{ ...homeOff, tools: probeModule.tools }] });
    const body = await rpc(await post(handler, readResource(PLAN_URI), { authorization: `Bearer ${HOME_TOKEN}` }));
    expect(body.error?.code).toBe(-32002);
  });

  it('is refused without a token (401 missing_token), like every other method', async () => {
    const { handler } = makeHandler({ modules: [cards] });
    const res = await post(handler, readResource(PLAN_URI), { authorization: undefined });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code?: string }).code).toBe('missing_token');
  });

  it('turns a document that cannot be built into an internal error with its reason, logged', async () => {
    const { handler, logs } = makeHandler({ modules: [cards] });
    const body = await rpc(await post(handler, readResource(BROKEN_URI)));
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toContain('The card bundle is not built.');
    expect(logs).toEqual([expect.objectContaining({ code: 'invalid_config', details: { resource: BROKEN_URI } })]);
  });

  it('turns a read that throws into an internal error without leaking it, logged', async () => {
    const throwing: CapabilityModule = {
      ...cards,
      resources: [{ uri: PLAN_URI, name: 'plan-card', title: 'Plan card', description: 'x', read: () => { throw new Error('EACCES /secret/path'); } }],
    };
    const { handler, logs } = makeHandler({ modules: [throwing] });
    const body = await rpc(await post(handler, readResource(PLAN_URI)));
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).not.toContain('secret');
    expect(logs).toEqual([expect.objectContaining({ code: 'unexpected_error', details: { resource: PLAN_URI, errorName: 'Error' } })]);
  });
});
