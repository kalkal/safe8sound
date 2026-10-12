import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ApplyPlanOutputSchema, LogEntrySchema } from '@cold-reserve/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDemoSession } from '../../src/agent/demo-session.js';
import { createRemoteAgent } from '../../src/agent/remote-agent.js';
import { createLogger } from '../../src/log.js';
import { createRemoteLogSink } from '../../src/remote-log.js';
import { fetchReserve } from '../../src/ui/reserve.js';

// Remote mode end to end (#101): the simulator's RemoteAgent and demo session against the REAL local
// sim-api, agent (fake model) and MCP server, each in its own process on 127.0.0.1. No AWS.
const APPS = join(import.meta.dirname, '..', '..', '..');
const ORIGIN = 'http://127.0.0.1:5400';
const CODE = randomBytes(12).toString('hex');
const KEY = randomBytes(32);
/** The daily cap of turns per demo code that sim-api runs with here. */
const TURNS_PER_CODE = 4;
const AGENT_MCP = randomBytes(24).toString('hex');
const SIM_MCP = randomBytes(24).toString('hex');
const INVOKE = randomBytes(24).toString('hex');
const children: ChildProcess[] = [];
/** Everything each app wrote on stdout: its JSON log lines (#125 reads sim-api's). */
const stdout: Record<string, string> = {};
let simApi: string;

function start(app: string, env: Record<string, string>): Promise<string> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/local.ts'], { cwd: join(APPS, app), env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (d: Buffer) => {
    stdout[app] = (stdout[app] ?? '') + String(d);
  });
  child.stderr.on('data', (d: Buffer) => process.stderr.write(`[${app}] ${String(d)}`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${app} did not start within 40 s`));
    }, 40_000);
    child.stdout.on('data', (d: Buffer) => {
      // The URL ends at the closing quote of the JSON message, wherever the message sits in the line.
      const found = /listening on ([^"\s]+)"/.exec(String(d));
      if (found?.[1]) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    child.once('exit', (code) => {
      reject(new Error(`${app} exited early with ${String(code)}`));
    });
  });
}

beforeAll(async () => {
  const mcp = await start('mcp-server', {
    // As deployed (#233): the agent always names its turn, the card actions never do.
    MCP_CLIENTS: `agent:agent@demo#*=${AGENT_MCP},cards:simapi@demo#*=${SIM_MCP}`,
    MCP_SCENARIO: 'clear-day',
    MCP_SCENARIO_START_H: '14',
    MCP_SCENARIO_SPEED: '0',
  });
  const agent = await start('agent', { AGENT_MCP_URL: mcp, AGENT_MCP_TOKEN: AGENT_MCP, AGENT_INVOKE_TOKEN: INVOKE });
  simApi = await start('sim-api', {
    SIM_DEMO_CODES: `judges:${createHash('sha256').update(CODE).digest('hex')}`,
    SIM_TOKEN_KEYS: `k1:${KEY.toString('base64url')}`,
    SIM_ALLOWED_ORIGINS: ORIGIN,
    SIM_LIMIT_TURNS_PER_CODE: String(TURNS_PER_CODE),
    SIM_AGENT_URL: agent,
    AGENT_INVOKE_TOKEN: INVOKE,
    SIM_MCP_URL: mcp,
    SIM_MCP_TOKEN: SIM_MCP,
  });
}, 120_000);
afterAll(async () => {
  await Promise.all(
    children.map(
      (c) =>
        new Promise((resolve) => {
          c.once('exit', resolve);
          c.kill();
        }),
    ),
  );
});

const remote = () => {
  const session = createDemoSession({ baseUrl: simApi, timeoutMs: 15_000 });
  return { session, agent: createRemoteAgent({ baseUrl: simApi, timeoutMs: 15_000, session }) };
};

describe('remote mode: simulator -> sim-api -> agent -> MCP server', () => {
  it("answers \"What's my battery level?\" after the demo code, with the server's simulated reading", async () => {
    const { session, agent } = remote();
    expect(await session.start(CODE)).toEqual({ ok: true, value: undefined });
    const answer = await agent.ask("What's my battery level?", { correlationId: crypto.randomUUID() });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.text).toMatch(/Battery at \d+(\.\d+)?%/);
    expect(answer.value.status?.origin).toMatchObject({ energy: 'simulated' });
  }, 60_000);

  it('a setpoint the guard refuses is answered with the plan that holds, ready to apply from its card (#202)', async () => {
    const { session, agent } = remote();
    await session.start(CODE);
    const answer = await agent.ask('Cool every room to 21 degrees now.', { correlationId: crypto.randomUUID() });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const plans = answer.value.cards?.filter((c) => c.tool === 'plan_comfort') ?? [];
    // One plan card, the plan that holds: never a refusal card on its own.
    expect(plans).toHaveLength(1);
    const card = plans[0];
    if (card?.tool !== 'plan_comfort' || !('id' in card.result)) throw new Error('no plan card');
    expect(card.result.refusedProposal?.code).toBeDefined();
    expect(card.result.guarantees.every((g) => g.ok)).toBe(true);
    // The voice says the refusal first, never "applied".
    expect(answer.value.text).toMatch(/^The safety check refused the plan you proposed: /);
    expect(answer.value.text).not.toMatch(/applied/i);
    // And the plan is applicable as it is, from its card.
    const applied = await agent.callTool('apply_plan', { planId: card.result.id }, { correlationId: crypto.randomUUID() });
    expect(applied.isError).toBeFalsy();
    expect(ApplyPlanOutputSchema.parse(applied.structuredContent)).toMatchObject({ alreadyApplied: false, plan: { id: card.result.id } });
  }, 60_000);

  it('applies a plan from its card (the card action goes through sim-api to the MCP server)', async () => {
    const { session, agent } = remote();
    await session.start(CODE);
    const answer = await agent.ask('Make the house cooler this afternoon.', { correlationId: crypto.randomUUID() });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const card = answer.value.cards?.find((c) => c.tool === 'plan_comfort');
    expect(card?.tool).toBe('plan_comfort');
    if (card?.tool !== 'plan_comfort' || !('id' in card.result)) throw new Error('no plan card');
    const applied = await agent.callTool('apply_plan', { planId: card.result.id }, { correlationId: crypto.randomUUID() });
    expect(applied.isError).toBeFalsy();
    // The applied plan itself, as the card shows it (review of #140): the same plan, applied once, on a sandbox.
    const result = ApplyPlanOutputSchema.parse(applied.structuredContent);
    expect(result).toMatchObject({ alreadyApplied: false, advisoryOnly: false, plan: { id: card.result.id } });
    expect(result.plan.homeId).toMatch(/^demo#[0-9a-f]{16}$/);
  }, 60_000);

  it("the idle screen's ice cubes read the reserve through sim-api (get_reserve_outlook on tools/call, #333)", async () => {
    const { session, agent } = remote();
    await session.start(CODE);
    const logged: unknown[] = [];
    const reserve = await fetchReserve(agent, { correlationId: crypto.randomUUID() }, (line) => logged.push(line));
    expect(reserve.ok).toBe(true);
    if (!reserve.ok) return;
    expect(reserve.value.hoursAtCurrentLevel).toBeGreaterThan(0);
    expect(logged).toEqual([]);
  }, 60_000);
});

describe('remote mode abuse cases are refused', () => {
  const post = (path: string, init: { token?: string; origin?: string; body: unknown }) =>
    fetch(`${simApi}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.origin ? { origin: init.origin } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
      body: JSON.stringify(init.body),
    });
  const code = async (res: Response) => ((await res.json()) as { code: string }).code;

  it('without a code: no token, 401 missing_token, and the RemoteAgent asks for the code', async () => {
    const res = await post('/v1/turns', { body: { question: 'Hi' } });
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('missing_token');
    const { agent } = remote();
    expect(await agent.ask('Hi', { correlationId: crypto.randomUUID() })).toMatchObject({ ok: false, error: { code: 'missing_token' } });
  });

  it('with a wrong code: 401 invalid_demo_code', async () => {
    expect(await remote().session.start('not-the-demo-code-at-all')).toMatchObject({ ok: false, error: { code: 'invalid_demo_code' } });
  });

  it('with an expired token: 401 signature_expired, and the session asks for the code again', async () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' })}.${b64({ iss: 'cold-reserve-sim-api', aud: 'sim-api', sub: 'judges', home: 'demo#0123456789abcdef', iat: now - 7200, exp: now - 3600, jti: 'x' })}`;
    const expired = `${input}.${createHmac('sha256', KEY).update(input).digest('base64url')}`;
    const res = await post('/v1/turns', { token: expired, body: { question: 'Hi' } });
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('signature_expired');
  });

  it('over the daily cap: 429 demo_quota_exceeded', async () => {
    const { session, agent } = remote();
    await session.start(CODE);
    const results = [];
    // limit + 1 questions in this test alone: the last one is refused whatever the other tests used (review of #140).
    for (let i = 0; i <= TURNS_PER_CODE; i++) results.push(await agent.ask("What's my battery level?", { correlationId: crypto.randomUUID() }));
    expect(results.at(-1)).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', category: 'rate_limited' } });
  }, 120_000);

  it('from a foreign origin: 403 origin_not_allowed', async () => {
    const res = await post('/v1/session', { origin: 'https://evil.example', body: { code: CODE } });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('origin_not_allowed');
  });
});

describe('browser logs reach sim-api (#125): page logger -> remote sink -> POST /v1/log -> one server line', () => {
  it("a page warning lands in sim-api's log with the turn's correlation id, the home as \"sandbox\", never the token", async () => {
    const { session } = remote();
    await session.start(CODE);
    const token = session.token();
    if (token === undefined) throw new Error('no session');
    const sent: Promise<Response>[] = [];
    const remoteLog = createRemoteLogSink({
      url: `${simApi}/v1/log`,
      token: () => session.token(),
      fetchFn: (url, init) => {
        const response = fetch(url, init);
        sent.push(response);
        return response;
      },
      schedule: () => undefined,
      now: () => Date.now(),
    });
    const log = createLogger('alexa-sim', remoteLog.sink, { pageId: crypto.randomUUID() });
    const turn = crypto.randomUUID();
    log({ level: 'warn', code: 'phone_inbox_unreachable', correlationId: turn, error: new TypeError('Failed to fetch'), details: { step: 'poll' } });
    remoteLog.flush();
    expect((await sent[0])?.status).toBe(204);

    const deadline = Date.now() + 5000;
    const mine = () =>
      (stdout['sim-api'] ?? '')
        .split('\n')
        .filter((l) => l.includes(turn))
        .map((l) => JSON.parse(l) as unknown);
    while (mine().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const [line] = mine();
    expect(LogEntrySchema.parse(line)).toMatchObject({
      level: 'warn',
      component: 'alexa-sim',
      message: 'phone_inbox_unreachable',
      correlationId: turn,
      code: 'agent_unavailable',
      category: 'dependency_unavailable',
      errorName: 'TypeError',
      details: { step: 'poll', via: 'log_route', codeId: 'judges', home: 'sandbox' },
    });
    const text = JSON.stringify(line);
    expect(text).not.toContain(token);
    expect(text).not.toContain('demo#');
    expect(text).not.toContain('Failed to fetch');
  }, 60_000);
});
