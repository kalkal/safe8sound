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
  result?: { tools?: { name: string }[]; structuredContent?: unknown; isError?: boolean };
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
    execFile(process.execPath, argv, { cwd: APP_ROOT, timeout: 60_000 }, (error, stdout, stderr) => {
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
