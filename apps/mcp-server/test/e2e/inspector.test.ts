import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { HomeStatusSchema } from '@cold-reserve/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROOT, startLocalServer, type LocalServer } from './local-server.js';

// The MCP Inspector CLI against the real local Node entry (plan §10.3). Set MCP_E2E_PORT=3316 for
// the acceptance run; CI uses a random port.
const INSPECTOR = join(APP_ROOT, 'node_modules', '@modelcontextprotocol', 'inspector', 'clients', 'launcher', 'build', 'index.js');
const ACCESS_VIOLATION = 3221225477; // 0xC0000005: intermittent native crash on the dev PC, retried
const TIMEOUT = 120_000;

interface Run {
  status: number;
  result?: {
    tools?: { name: string; _meta?: { ui?: { resourceUri?: string } } }[];
    resources?: { uri: string; mimeType?: string }[];
    contents?: { uri: string; mimeType?: string; text?: string; _meta?: unknown }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  stderr: string;
}

let server: LocalServer;

beforeAll(async () => {
  const port = process.env['MCP_E2E_PORT'];
  server = await startLocalServer({ client: 'inspector', ...(port ? { port: Number(port) } : {}), env: { MCP_SCENARIO: 'clear-day' } });
}, 60_000);
afterAll(() => {
  server.stop();
});

function once(args: string[], headers: string[]): Promise<Run> {
  const argv = [INSPECTOR, '--cli', server.url, '--transport', 'http', '--format', 'json', ...headers.flatMap((h) => ['--header', h]), ...args];
  return new Promise((resolve) => {
    execFile(process.execPath, argv, { cwd: APP_ROOT, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      let result: Run['result'];
      try {
        result = (JSON.parse(stdout) as { result?: Run['result'] }).result;
      } catch {
        result = undefined; // not JSON: the checks below report it
      }
      const code = error?.code;
      resolve({ status: typeof code === 'number' ? code : error ? 1 : 0, ...(result ? { result } : {}), stderr: stderr.trim() });
    });
  });
}

async function inspect(args: string[], headers = [`Authorization: Bearer ${server.token}`]): Promise<Run> {
  let run = await once(args, headers);
  for (let attempt = 1; attempt < 3 && run.status === ACCESS_VIOLATION; attempt++) run = await once(args, headers);
  return run;
}

describe('MCP Inspector CLI against the local entry', () => {
  it('lists get_home_status', { timeout: TIMEOUT }, async () => {
    const run = await inspect(['--method', 'tools/list']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.result?.tools?.map((t) => t.name)).toContain('get_home_status');
  });

  it('finds no error-severity schema problems (--strict)', { timeout: TIMEOUT }, async () => {
    const run = await inspect(['--method', 'tools/list', '--strict']);
    expect(run.status, run.stderr).toBe(0);
  });

  it('calls get_home_status: valid structuredContent with dataOrigin simulated', { timeout: TIMEOUT }, async () => {
    const run = await inspect(['--method', 'tools/call', '--tool-name', 'get_home_status']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.result?.isError).toBeFalsy();
    const status = HomeStatusSchema.parse(run.result?.structuredContent);
    expect(status.origin).toMatchObject({ energy: 'simulated', rooms: 'simulated', weather: 'simulated' });
  });

  it('shows the four cards as ui:// MCP Apps resources (#92)', { timeout: TIMEOUT }, async () => {
    const run = await inspect(['--method', 'resources/list']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.result?.resources?.map((r) => [r.uri, r.mimeType])).toEqual(
      ['plan-card', 'applied-plan', 'reserve-outlook', 'preferences'].map((card) => [`ui://cold-reserve/${card}`, 'text/html;profile=mcp-app']),
    );
  });

  // Needs the built card bundle: CI and `pnpm check` build it before `pnpm test`.
  it('reads the plan card: one self-contained document that declares its CSP', { timeout: TIMEOUT }, async () => {
    const run = await inspect(['--method', 'resources/read', '--uri', 'ui://cold-reserve/plan-card']);
    expect(run.status, run.stderr).toBe(0);
    const [document] = run.result?.contents ?? [];
    expect(document).toMatchObject({ uri: 'ui://cold-reserve/plan-card', mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: { connectDomains: [] } } } });
    expect(document?.text).toMatch(/^<!doctype html>/);
    expect(document?.text).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'');
    expect(document?.text).toContain('<div id="root" data-card="plan"></div>');
  });

  it('links plan_comfort, apply_plan, get_reserve_outlook and get_preferences to their cards', { timeout: TIMEOUT }, async () => {
    const run = await inspect(['--method', 'tools/list']);
    expect(run.status, run.stderr).toBe(0);
    const linked = Object.fromEntries((run.result?.tools ?? []).filter((t) => t._meta).map((t) => [t.name, t._meta?.ui?.resourceUri]));
    expect(linked).toEqual({
      plan_comfort: 'ui://cold-reserve/plan-card',
      apply_plan: 'ui://cold-reserve/applied-plan',
      get_reserve_outlook: 'ui://cold-reserve/reserve-outlook',
      get_preferences: 'ui://cold-reserve/preferences',
    });
  });

  it('is refused without a token (401 missing_token) and with a wrong one (401 wrong_client)', { timeout: TIMEOUT }, async () => {
    const none = await inspect(['--method', 'tools/list', '--stored-auth-only'], []);
    expect(none.status).not.toBe(0);
    expect(none.stderr).toMatch(/401/);
    expect(none.stderr).toMatch(/missing_token/);
    const wrong = await inspect(['--method', 'tools/list', '--stored-auth-only'], [`Authorization: Bearer ${'x'.repeat(48)}`]);
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toMatch(/401/);
    expect(wrong.stderr).toMatch(/wrong_client/);
  });
});
