import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import type { LogEntry } from '@cold-reserve/contracts';
import type { McpCaller, SkillDeps, SkillTool } from '../src/index.js';

/** A fake skill ID: the real one is given at deploy time only, never in the repo. */
export const SKILL_ID = 'amzn1.ask.skill.00000000-0000-0000-0000-000000000000';
export const OTHER_SKILL_ID = 'amzn1.ask.skill.11111111-1111-1111-1111-111111111111';
export const CID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
export const TOKEN = 't'.repeat(48);

export const FIXTURES = join(import.meta.dirname, 'fixtures');
/** A recorded-shape Alexa request (fake ids only), from test/fixtures. */
export const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Record<string, unknown>;

/** The fixture with another request inside, and the session marked new or not. */
export function withRequest(request: Record<string, unknown>, opts: { sessionNew?: boolean; applicationId?: string } = {}): Record<string, unknown> {
  const base = fixture('launch');
  const session = base['session'] as Record<string, unknown>;
  const context = base['context'] as { System: Record<string, unknown> };
  const application = { applicationId: opts.applicationId ?? SKILL_ID };
  return {
    ...base,
    session: { ...session, new: opts.sessionNew ?? false, application },
    context: { ...context, System: { ...context.System, application } },
    request: { type: 'IntentRequest', requestId: 'amzn1.echo-api.request.fake', timestamp: '2026-10-12T18:00:00Z', locale: 'en-US', ...request },
  };
}
export const intent = (name: string, opts?: { sessionNew?: boolean; applicationId?: string }) => withRequest({ intent: { name, confirmationStatus: 'NONE' } }, opts);

export const homeStatus = () => ({
  homeId: 'demo',
  ts: '2026-07-15T14:00:00+02:00',
  batterySocPct: 62.4,
  pvW: 3100,
  loadW: 900,
  gridW: -400,
  gridAvailable: true,
  level: 'balanced',
  levelReason: 'weather',
  levelChangedAt: '2026-07-15T12:00:00+02:00',
  controlAvailability: 'ok',
  rooms: [
    { roomId: 'living_room', tempC: 26.1, occupants: ['grandpa'], state: 'served' },
    { roomId: 'bedroom', tempC: 27.3, occupants: [], state: 'waiting', waitingReason: 'pacing_level' },
    { roomId: 'study', tempC: 27.9, occupants: [], state: 'served' },
  ],
  origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'clear-day' },
  homeLink: 'ok',
});

export const reserveOutlook = () => exampleReserveOutlook();

export const safeRoomStatus = () => ({
  safeRoomId: 'living_room',
  safeRoomName: 'Living room',
  tempC: 26.1,
  occupantRoles: ['grandpa'],
  level: 'balanced',
  levelReason: 'weather',
  safeHours: 11.6,
  safeUntil: '2026-07-16T01:36:00+02:00',
  gridAvailable: false,
  origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' },
  homeLink: 'ok',
});

const OUTPUTS: Record<SkillTool, () => Record<string, unknown>> = {
  get_home_status: homeStatus,
  get_reserve_outlook: reserveOutlook,
  get_safe_room_status: safeRoomStatus,
};

/** A CallToolResult as the MCP server sends it. */
export const toolResult = (structuredContent: unknown, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: 'summary' }], structuredContent });

/** A fake MCP caller recording each call; by default it answers each tool with a valid output. */
export function fakeCaller(answer?: (name: SkillTool) => Promise<unknown>) {
  const calls: { name: SkillTool; token: string; correlationId: string }[] = [];
  const caller: McpCaller = (name, _args, opts) => {
    calls.push({ name, token: opts.token, correlationId: opts.correlationId });
    return answer ? answer(name) : Promise.resolve(toolResult(OUTPUTS[name]()));
  };
  return { caller, calls };
}

export function makeDeps(over: Partial<SkillDeps> = {}) {
  const lines: LogEntry[] = [];
  let tokenReads = 0;
  const fake = fakeCaller();
  const deps: SkillDeps = {
    skillId: SKILL_ID,
    token: () => {
      tokenReads += 1;
      return Promise.resolve({ ok: true, value: TOKEN });
    },
    caller: fake.caller,
    timing: { deadlineMs: 6000, ssmTimeoutMs: 1500, mcpTimeoutMs: 4000 },
    tempUnit: 'C',
    log: (e) => lines.push(e),
    newId: () => CID,
    now: () => Date.parse('2026-10-12T18:00:00Z'),
    ...over,
  };
  return { deps, lines, calls: fake.calls, tokenReads: () => tokenReads };
}

/** The plain text inside the SSML of a response, with the XML entities read back. */
export const spoken = (r: { response: { outputSpeech?: { ssml: string } } }) =>
  (r.response.outputSpeech?.ssml ?? '')
    .replace(/^<speak>|<\/speak>$/g, '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
