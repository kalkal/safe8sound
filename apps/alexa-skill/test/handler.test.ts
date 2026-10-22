import { LogEntrySchema, toolError } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { escapeSsml, handle } from '../src/index.js';
import { CID, OTHER_SKILL_ID, TOKEN, fakeCaller, fixture, homeStatus, intent, makeDeps, reserveOutlook, safeRoomStatus, spoken, toolResult, withRequest } from './support.js';

const never = () => new Promise<never>(() => undefined);

describe('handle: the requests that read the home', () => {
  it('LaunchRequest reads get_home_status, says the demo home once, and keeps the session open', async () => {
    const fake = fakeCaller();
    const { deps } = makeDeps({ caller: fake.caller });
    const r = await handle(fixture('launch'), deps);
    expect(fake.calls).toEqual([{ name: 'get_home_status', token: TOKEN, correlationId: CID }]);
    const text = spoken(r);
    expect(text.startsWith('This is the simulated demo home. ')).toBe(true);
    expect(text.split('simulated demo home')).toHaveLength(2);
    expect(text).toContain('The battery is at 62 percent, at the balanced level. 2 of 3 rooms are served. The grid is on.');
    expect(r.response.shouldEndSession).toBe(false);
    expect(r.response.reprompt?.outputSpeech.ssml).toMatch(/^<speak>.+<\/speak>$/);
  });

  it('ReserveOutlookIntent reads get_reserve_outlook and says its hours; an open session stays open', async () => {
    const fake = fakeCaller();
    const r = await handle(fixture('reserve-outlook'), makeDeps({ caller: fake.caller }).deps);
    expect(fake.calls.map((c) => c.name)).toEqual(['get_reserve_outlook']);
    expect(spoken(r)).toBe(
      'At the comfort level, the battery alone lasts about 10 hours. At the essential level, about 18 hours. The storm reserve on its own covers about 10 hours at the essential level.',
    );
    expect(spoken(r)).not.toContain('simulated demo home');
    expect(r.response.shouldEndSession).toBe(false);
  });

  it('a one-shot request ("ask ... how long the reserve lasts") ends with the answer', async () => {
    const r = await handle(intent('ReserveOutlookIntent', { sessionNew: true }), makeDeps().deps);
    expect(r.response.shouldEndSession).toBe(true);
    expect(r.response.reprompt).toBeUndefined();
  });

  it('SafeRoomIntent reads get_safe_room_status and says the room, its temperature in the configured unit and its hours', async () => {
    const fake = fakeCaller();
    const r = await handle(intent('SafeRoomIntent'), makeDeps({ caller: fake.caller }).deps);
    expect(fake.calls.map((c) => c.name)).toEqual(['get_safe_room_status']);
    expect(spoken(r)).toBe('The safe room, Living room, is at 26.1 degrees Celsius. 1 person is in it. It stays safe for about 12 hours.');
    const f = await handle(intent('SafeRoomIntent'), makeDeps({ tempUnit: 'F' }).deps);
    expect(spoken(f)).toContain('79 degrees Fahrenheit');
  });

  it('a safe room already past its limit is said so, without the reassuring safe hours', async () => {
    const above = { ...safeRoomStatus(), tempC: 27.4, limitNow: { limitC: 26, kind: 'night' } };
    const r = await handle(intent('SafeRoomIntent'), makeDeps({ caller: fakeCaller(() => Promise.resolve(toolResult(above))).caller }).deps);
    expect(spoken(r)).toBe('The safe room, Living room, is at 27.4 degrees Celsius. 1 person is in it. It is above the night limit of 26 degrees Celsius now.');
    const below = { ...safeRoomStatus(), tempC: 15.2, limitNow: { limitC: 16, kind: 'minimum' } };
    const cold = await handle(intent('SafeRoomIntent'), makeDeps({ caller: fakeCaller(() => Promise.resolve(toolResult(below))).caller }).deps);
    expect(spoken(cold)).toContain('It is below the safety minimum of 16 degrees Celsius now.');
    expect(spoken(cold)).not.toContain('safe for');
    // Inside the limit: the safe hours as usual.
    const inside = { ...safeRoomStatus(), limitNow: { limitC: 28, kind: 'maximum' } };
    const fine = await handle(intent('SafeRoomIntent'), makeDeps({ caller: fakeCaller(() => Promise.resolve(toolResult(inside))).caller }).deps);
    expect(spoken(fine)).toContain('It stays safe for about 12 hours.');
  });

  it('with the grid on it says first what the battery keeps going if the power goes now, never the comfort hours as the battery (owner, 22 Oct)', async () => {
    const outlook = { ...reserveOutlook(), level: 'comfort', hoursAtCurrentLevel: 0, hoursAtEssential: 0, reserveHoursAtEssential: 7.7, hoursIfOutageNow: 8.4, gridAvailable: true };
    const fake = fakeCaller(() => Promise.resolve(toolResult(outlook)));
    const said = spoken(await handle(fixture('reserve-outlook'), makeDeps({ caller: fake.caller }).deps));
    expect(said).toMatch(/^If the power goes now, the battery keeps the home going for about 8 hours at the essential level\. /);
    expect(said).not.toMatch(/the battery alone lasts/);
  });

  it('every number it says comes from the structuredContent', async () => {
    // Other values in, other numbers out: nothing spoken is a constant of the skill.
    const outputs = {
      get_home_status: { ...homeStatus(), batterySocPct: 17, rooms: homeStatus().rooms.slice(0, 1) },
      get_reserve_outlook: { ...reserveOutlook(), level: 'saver', hoursAtCurrentLevel: 3.2, hoursAtEssential: 5.7, reserveHoursAtEssential: 0.4 },
      get_safe_room_status: { ...safeRoomStatus(), tempC: 31.4, safeHours: 2.4, occupantRoles: [], gridAvailable: true },
    } as const;
    const fake = fakeCaller((name) => Promise.resolve(toolResult(outputs[name])));
    const deps = makeDeps({ caller: fake.caller }).deps;
    const said = await Promise.all([handle(fixture('launch'), deps), handle(fixture('reserve-outlook'), deps), handle(intent('SafeRoomIntent'), deps)]).then((rs) => rs.map(spoken));
    expect(said[0]).toContain('The battery is at 17 percent, at the balanced level. 1 of 1 room is served.');
    expect(said[1]).toBe('At the saver level, the battery alone lasts about 3 hours. At the essential level, about 6 hours. The storm reserve on its own covers less than an hour at the essential level.');
    expect(said[2]).toBe('The safe room, Living room, is at 31.4 degrees Celsius. Nobody is in it. The grid powers it; on the battery alone it would stay safe for about 2 hours.');
  });
});

describe('handle: the built-in intents never call the MCP server', () => {
  it.each([
    ['AMAZON.HelpIntent', false],
    ['AMAZON.StopIntent', true],
    ['AMAZON.CancelIntent', true],
    ['AMAZON.NavigateHomeIntent', true],
    ['AMAZON.FallbackIntent', false],
  ])('%s', async (name, ends) => {
    const { deps, calls, tokenReads } = makeDeps();
    const r = await handle(intent(name), deps);
    expect(calls).toEqual([]);
    expect(tokenReads()).toBe(0);
    expect(r.response.shouldEndSession).toBe(ends);
    expect(spoken(r).length).toBeGreaterThan(0);
  });

  it('Stop says goodbye and ends', async () => {
    expect(spoken(await handle(fixture('stop'), makeDeps().deps))).toBe('Goodbye.');
  });

  it('SessionEndedRequest gets an empty response and is logged with its reason only', async () => {
    const { deps, calls, lines } = makeDeps();
    const r = await handle(withRequest({ type: 'SessionEndedRequest', reason: 'USER_INITIATED', error: { type: 'X', message: 'secret detail' } }), deps);
    expect(r).toEqual({ version: '1.0', response: {} });
    expect(calls).toEqual([]);
    expect(lines.at(-1)?.details).toMatchObject({ requestType: 'SessionEndedRequest', reason: 'USER_INITIATED' });
    expect(JSON.stringify(lines)).not.toContain('secret detail');
  });

  it('an unknown intent gets the fallback answer and a warning', async () => {
    const { deps, calls, lines } = makeDeps();
    const r = await handle(intent('OrderPizzaIntent'), deps);
    expect(calls).toEqual([]);
    expect(spoken(r)).toContain("Sorry, I can't help with that.");
    expect(lines.find((l) => l.level === 'warn')).toMatchObject({ code: 'invalid_input', category: 'validation' });
  });

  it('another request type (not Launch, Intent or SessionEnded) gets an empty response', async () => {
    const { deps, calls } = makeDeps();
    expect(await handle(withRequest({ type: 'System.ExceptionEncountered' }), deps)).toEqual({ version: '1.0', response: {} });
    expect(calls).toEqual([]);
  });
});

describe('handle: the skill ID is checked before anything else', () => {
  it.each([
    ['context', (r: Record<string, unknown>) => ({ ...r, context: { System: { application: { applicationId: OTHER_SKILL_ID } } } })],
    ['session', (r: Record<string, unknown>) => ({ ...r, session: { new: true, application: { applicationId: OTHER_SKILL_ID } } })],
  ])('a wrong applicationId in the %s never reads the token nor calls MCP', async (_where, change) => {
    const { deps, calls, lines, tokenReads } = makeDeps();
    const r = await handle(change(fixture('launch')), deps);
    expect(r).toEqual({ version: '1.0', response: {} });
    expect(calls).toEqual([]);
    expect(tokenReads()).toBe(0);
    expect(lines).toEqual([expect.objectContaining({ level: 'warn', code: 'wrong_client', category: 'unauthorized' })]);
    expect(JSON.stringify(lines)).not.toContain(OTHER_SKILL_ID);
  });

  it('a body that is not an Alexa envelope is refused without a call', async () => {
    const { deps, calls, lines } = makeDeps();
    const r = await handle({ hello: 'world' }, deps);
    expect(calls).toEqual([]);
    expect(r.response.shouldEndSession).toBe(true);
    expect(lines[0]).toMatchObject({ level: 'warn', code: 'invalid_input' });
  });
});

describe('handle: degraded paths are short apologies, the detail is in the log', () => {
  const run = async (over: Parameters<typeof makeDeps>[0]) => {
    const made = makeDeps(over);
    const r = await handle(fixture('launch'), made.deps);
    return { r, text: spoken(r), lines: made.lines };
  };

  it('SSM does not answer in time: config_unavailable, MCP never called', async () => {
    const fake = fakeCaller();
    const { r, text, lines } = await run({ token: never, caller: fake.caller, timing: { deadlineMs: 6000, ssmTimeoutMs: 30, mcpTimeoutMs: 4000 } });
    expect(fake.calls).toEqual([]);
    expect(text).toBe('I cannot reach the home right now. Please try again in a moment.');
    expect(r.response.shouldEndSession).toBe(true);
    expect(lines.at(-1)).toMatchObject({ level: 'warn', code: 'config_unavailable', details: { tool: 'get_home_status' } });
  });

  it('SSM answers a setup error: invalid_config, logged as an error', async () => {
    const { text, lines } = await run({ token: () => Promise.resolve({ ok: false, error: toolError('invalid_config', 'Parameter /x could not be read (HTTP 403).') }) });
    expect(text).toBe('Something went wrong on our side. Please try again later.');
    expect(lines.at(-1)).toMatchObject({ level: 'error', code: 'invalid_config', category: 'internal' });
  });

  it('MCP does not answer in time: agent_timeout', async () => {
    const { text, lines } = await run({ caller: never, timing: { deadlineMs: 6000, ssmTimeoutMs: 1500, mcpTimeoutMs: 30 } });
    expect(text).toBe('The home did not answer in time. Please try again in a moment.');
    expect(lines.at(-1)).toMatchObject({ level: 'warn', code: 'agent_timeout', details: { tool: 'get_home_status' } });
  });

  it('the overall deadline stops the MCP call even when its own timeout is longer', async () => {
    const { lines } = await run({ caller: never, timing: { deadlineMs: 40, ssmTimeoutMs: 10, mcpTimeoutMs: 30 } });
    expect(lines.at(-1)).toMatchObject({ code: 'agent_timeout' });
  });

  it('MCP refuses the token (401): wrong_client, logged as an error with the cause name only', async () => {
    const refused = Object.assign(new Error('Error POSTing to endpoint: {"detail":"secret"}'), { name: 'StreamableHTTPError', code: 401 });
    const { text, lines } = await run({ caller: () => Promise.reject(refused) });
    expect(text).toBe('Something went wrong on our side. Please try again later.');
    expect(lines.at(-1)).toMatchObject({ level: 'error', code: 'wrong_client', errorName: 'StreamableHTTPError' });
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  it('MCP unreachable: agent_unavailable', async () => {
    const { text, lines } = await run({ caller: () => Promise.reject(new TypeError('fetch failed')) });
    expect(text).toBe('I cannot reach the home right now. Please try again in a moment.');
    expect(lines.at(-1)).toMatchObject({ code: 'agent_unavailable', errorName: 'TypeError' });
  });

  it('the tool answers isError: its envelope code is logged, the voice stays generic', async () => {
    const envelope = toolError('home_data_stale', 'The home data is too old.');
    const { text, lines } = await run({ caller: () => Promise.resolve(toolResult(envelope, true)) });
    expect(text).toBe('I cannot reach the home right now. Please try again in a moment.');
    expect(lines.at(-1)).toMatchObject({ code: 'home_data_stale' });
    expect(lines.at(-1)?.message).toContain('(tool)');
  });

  it.each([
    ['an isError without an envelope', toolResult({ nope: true }, true)],
    ['structuredContent outside the output schema', toolResult({ ...homeStatus(), batterySocPct: 'high' })],
    ['no structuredContent', { content: [{ type: 'text', text: 'Battery at 62%.' }] }],
    ['not a CallToolResult', 'plain text'],
  ])('%s: output_schema_violation', async (_case, reply) => {
    const { text, lines } = await run({ caller: () => Promise.resolve(reply) });
    expect(text).toBe('The home sent an answer I could not read. Please try again later.');
    expect(lines.at(-1)).toMatchObject({ level: 'error', code: 'output_schema_violation', category: 'internal' });
  });
});

describe('logs', () => {
  it('every line is a valid LogEntry with the correlation id, and none carries an id of the person, a token or error text', async () => {
    const { deps, lines } = makeDeps({ caller: () => Promise.reject(Object.assign(new Error('Bearer leaked-token'), { code: 401 })) });
    const ok = makeDeps();
    for (const name of ['launch', 'reserve-outlook', 'help', 'stop']) await handle(fixture(name), ok.deps);
    await handle(fixture('launch'), deps);
    await handle(intent('NopeIntent'), ok.deps);
    const all = [...ok.lines, ...lines];
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const line of all) {
      expect(LogEntrySchema.safeParse(line).success).toBe(true);
      expect(line.correlationId).toBe(CID);
      expect(line.component).toBe('alexa-skill');
    }
    const text = JSON.stringify(all);
    for (const secret of ['FAKE-USER-ID', 'FAKE-DEVICE-ID', 'fake-session-id', 'fake.api.access.token', 'amzn1.echo-api.request', TOKEN, 'leaked-token', 'userId', 'deviceId', 'sessionId', 'apiAccessToken']) {
      expect(text).not.toContain(secret);
    }
  });

  it('a successful request logs one info line with the request type, intent, tool and duration', async () => {
    const { deps, lines } = makeDeps();
    await handle(fixture('reserve-outlook'), deps);
    expect(lines).toEqual([
      expect.objectContaining({ level: 'info', details: { requestType: 'IntentRequest', intent: 'ReserveOutlookIntent', tool: 'get_reserve_outlook', durationMs: 0 } }),
    ]);
  });
});

describe('SSML', () => {
  it('escapes every XML special character', () => {
    expect(escapeSsml(`a & b < c > "d" 'e'`)).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
  });

  it('the spoken text is plain text inside <speak>, with the apostrophes escaped', async () => {
    const r = await handle(intent('NopeIntent'), makeDeps().deps);
    expect(r.response.outputSpeech?.type).toBe('SSML');
    expect(r.response.outputSpeech?.ssml).toMatch(/^<speak>Sorry, I can&apos;t help with that\. [^<>]+<\/speak>$/);
  });
});

describe('handle: no raw room id is ever said (#192)', () => {
  it('a status without a room name says "The safe room" and no id', async () => {
    const bare: Record<string, unknown> = { ...safeRoomStatus() };
    delete bare['safeRoomName'];
    const r = await handle(intent('SafeRoomIntent'), makeDeps({ caller: fakeCaller(() => Promise.resolve(toolResult(bare))).caller }).deps);
    expect(spoken(r)).toMatch(/^The safe room is at 26\.1 degrees Celsius\./);
    expect(spoken(r)).not.toMatch(/living|_|bedroom/i);
  });
});
