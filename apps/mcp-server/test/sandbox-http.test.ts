import { ProblemDetailsSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createMcpHandler, type LogEntry } from '../src/handler.js';
import { createRegistry } from '../src/registry.js';
import { createSandboxes } from '../src/sandboxes.js';
import { HOME_TOKEN, TOKEN, callTool, homeId, post, probeModule, testConfig, toolResult } from './helpers.js';

// The sandbox header (#101): only a demo#* grant may send it, only for demo#<16 hex>, and never for `home`.
const SANDBOX_TOKEN = 's'.repeat(32);
const SANDBOX = 'demo#0123456789abcdef';

function setup(maxNewPerDay = 10) {
  const created: string[] = [];
  const logs: LogEntry[] = [];
  const metrics: Record<string, unknown>[] = [];
  const registry = createRegistry([probeModule]);
  if (!registry.ok) throw new Error(registry.error.message);
  const config = testConfig({
    clients: new Map([
      [TOKEN, { clientId: 'agent', homeId: homeId('demo') }],
      [HOME_TOKEN, { clientId: 'video', homeId: homeId('home') }],
      [SANDBOX_TOKEN, { clientId: 'agent-sandbox', homeId: homeId('demo'), sandboxes: true }],
    ]),
  });
  const sandboxes = createSandboxes({
    clock: { now: () => Date.UTC(2026, 9, 1, 12) },
    ttlMs: 86_400_000,
    maxNewPerDay,
    create: (h) => {
      created.push(h);
      return h;
    },
  });
  const handler = createMcpHandler(config, { registry: registry.value, logger: { log: (e) => logs.push(e) }, sandboxes, metrics: (m) => metrics.push(m) });
  const whoami = (token: string, home?: string) => post(handler, callTool('whoami', {}), { authorization: `Bearer ${token}`, 'x-cold-reserve-home': home });
  return { whoami, created, logs, metrics };
}

async function refused(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(ProblemDetailsSchema.parse(await res.json()).code).toBe(code);
}

describe('x-cold-reserve-home: sandbox homes for the demo#* grant only', () => {
  it('serves the sandbox home of the header to a demo#* grant, and demo without a header', async () => {
    const { whoami, created } = setup();
    expect((await toolResult(await whoami(SANDBOX_TOKEN, SANDBOX))).structuredContent).toEqual({ clientId: 'agent-sandbox', homeId: SANDBOX });
    expect((await toolResult(await whoami(SANDBOX_TOKEN))).structuredContent).toEqual({ clientId: 'agent-sandbox', homeId: 'demo' });
    expect(created).toEqual([SANDBOX]);
  });

  it('refuses the header from a grant without sandboxes with 403 home_not_allowed', async () => {
    const { whoami, created } = setup();
    await refused(await whoami(TOKEN, SANDBOX), 403, 'home_not_allowed');
    await refused(await whoami(HOME_TOKEN, SANDBOX), 403, 'home_not_allowed');
    expect(created).toEqual([]);
  });

  it.each([
    ['the real home', 'home'],
    ['demo itself', 'demo'],
    ['uppercase hex', 'demo#0123456789ABCDEF'],
    ['a short id', 'demo#0123456789abcde'],
    ['a long id', 'demo#0123456789abcdef0'],
    ['extra characters', 'demo#0123456789abcdef;home'],
    ['another prefix', 'home#0123456789abcdef'],
  ])('refuses %s with 403 and never creates a sandbox', async (_name, header) => {
    const { whoami, created } = setup();
    await refused(await whoami(SANDBOX_TOKEN, header), 403, 'home_not_allowed');
    expect(created).toEqual([]);
  });

  it('answers 429 demo_quota_exceeded past the daily cap of new sandboxes', async () => {
    const { whoami } = setup(1);
    expect((await whoami(SANDBOX_TOKEN, SANDBOX)).status).toBe(200);
    await refused(await whoami(SANDBOX_TOKEN, 'demo#fedcba9876543210'), 429, 'demo_quota_exceeded');
  });

  it('logs a refused header and a refused new sandbox with the client id, never the requested home', async () => {
    const { whoami, logs } = setup(1);
    await whoami(TOKEN, SANDBOX);
    await whoami(SANDBOX_TOKEN, SANDBOX);
    await whoami(SANDBOX_TOKEN, 'demo#fedcba9876543210');
    // The refusals (the info line of the one call that went through names its own sandbox, #146).
    const refused = logs.filter((l) => l.level !== 'info');
    expect(refused).toMatchObject([
      { level: 'warn', code: 'home_not_allowed', category: 'forbidden', clientId: 'agent' },
      { level: 'warn', code: 'demo_quota_exceeded', category: 'rate_limited', clientId: 'agent-sandbox' },
    ]);
    expect(logs.every((l) => typeof l.correlationId === 'string')).toBe(true);
    expect(JSON.stringify(refused)).not.toContain('demo#');
  });

  it('a call in a sandbox leaves its line and its metric without the sandbox id (#146)', async () => {
    const { whoami, logs, metrics } = setup(1);
    await whoami(SANDBOX_TOKEN, SANDBOX);
    const line = logs.find((l) => l.level === 'info');
    expect(line).toMatchObject({ message: 'tools/call whoami', details: { home: 'sandbox' } });
    expect(line?.homeId).toBeUndefined();
    expect(metrics).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('demo#');
    expect(JSON.stringify(metrics)).not.toContain('demo#');
  });
});
