import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HomeStatusSchema, ReserveOutlookSchema, type LogEntry } from '@cold-reserve/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle, streamableMcpCaller, type SkillDeps } from '../../src/index.js';
import { SKILL_ID, fixture, spoken } from '../support.js';

// Scripted local run (#26, task 4): the recorded-shape Alexa requests in test/fixtures go through the real handler
// and the real MCP client to the REAL MCP server (apps/mcp-server, clear-day simulator) on 127.0.0.1, in its own
// process, with a `read:alexa@demo` token. The scenario clock is frozen (speed 0), so a direct call reads the same numbers.
const MCP_DIR = join(import.meta.dirname, '..', '..', '..', 'mcp-server');
const TOKEN = randomBytes(24).toString('hex');
let server: ChildProcess;
let url: string;
let serverOut = '';

beforeAll(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', join(MCP_DIR, 'src', 'local.ts')], {
    cwd: MCP_DIR,
    env: { ...process.env, PORT: '0', MCP_CLIENTS: `read:alexa@demo=${TOKEN}`, MCP_SCENARIO: 'clear-day', MCP_SCENARIO_START_H: '14', MCP_SCENARIO_SPEED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.resume();
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the MCP server did not start within 30 s'));
    }, 30_000);
    server.stdout?.on('data', (d: Buffer) => {
      serverOut += String(d);
      const found = /listening on (\S+)"/.exec(serverOut);
      if (found?.[1]) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    server.once('exit', (code) => {
      reject(new Error(`the MCP server exited early with ${String(code)}`));
    });
  });
}, 60_000);
afterAll(async () => {
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await exited;
});

const deps = (lines: LogEntry[], ids: string[], token = TOKEN): SkillDeps => ({
  skillId: SKILL_ID,
  token: () => Promise.resolve({ ok: true, value: token }),
  caller: streamableMcpCaller({ url }),
  timing: { deadlineMs: 6000, ssmTimeoutMs: 1500, mcpTimeoutMs: 4000 },
  tempUnit: 'C',
  log: (e) => lines.push(e),
  newId: () => {
    const id = randomUUID();
    ids.push(id);
    return id;
  },
  now: Date.now,
});

/** The tool's structuredContent read directly, to compare the numbers the skill says. */
async function direct(name: 'get_home_status' | 'get_reserve_outlook'): Promise<unknown> {
  const reply = (await streamableMcpCaller({ url })(name, {}, { token: TOKEN, signal: AbortSignal.timeout(5000), correlationId: randomUUID() })) as { structuredContent?: unknown };
  return reply.structuredContent;
}

describe('the skill against the local MCP server', () => {
  it('Launch, ReserveOutlook, Help, Stop: the scripted session', async () => {
    const lines: LogEntry[] = [];
    const ids: string[] = [];
    const d = deps(lines, ids);
    const status = HomeStatusSchema.parse(await direct('get_home_status'));
    const outlook = ReserveOutlookSchema.parse(await direct('get_reserve_outlook'));

    const launch = await handle(fixture('launch'), d);
    expect(spoken(launch)).toContain(`This is the simulated demo home. The battery is at ${String(Math.round(status.batterySocPct))} percent, at the ${status.level} level.`);
    expect(launch.response.shouldEndSession).toBe(false);

    const reserve = await handle(fixture('reserve-outlook'), d);
    // With the grid on, what the whole battery keeps going if the power goes now comes first (owner, 22 Oct).
    expect(spoken(reserve)).toContain(outlook.gridAvailable === true ? "If the power goes now, the battery keeps the home going for" : `At the ${outlook.level} level, the battery alone lasts`);
    expect(reserve.response.shouldEndSession).toBe(false);

    const help = await handle(fixture('help'), d);
    expect(spoken(help)).toContain('You can ask how long the reserve lasts');

    const stop = await handle(fixture('stop'), d);
    expect(spoken(stop)).toBe('Goodbye.');
    expect(stop.response.shouldEndSession).toBe(true);

    expect(lines.filter((l) => l.level !== 'info')).toEqual([]);
    // The correlation id of each tool request reaches the server's own log lines.
    await new Promise((r) => setTimeout(r, 200));
    expect(serverOut).toContain(ids[0]);
    expect(serverOut).toContain(ids[1]);
  });

  it('a token the server never issued: wrong_client, an apology, no crash', async () => {
    const lines: LogEntry[] = [];
    const r = await handle(fixture('launch'), deps(lines, [], 'x'.repeat(48)));
    expect(spoken(r)).toBe('Something went wrong on our side. Please try again later.');
    expect(lines.at(-1)).toMatchObject({ level: 'error', code: 'wrong_client' });
  });
});
