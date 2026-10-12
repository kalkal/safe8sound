import { describe, expect, it, vi } from 'vitest';
import { LogEntrySchema, toolError, type LogEntry } from '@cold-reserve/contracts';
import { HOST_EVENT_CODES, addLogSink, configErrorEvent, createLogger, log as pageLog, logUnhandled, voiceFailureEvent } from '../src/log.js';

// The browser on the shared logger (#143): every line is a LogEntry, never plain text, never a message or a
// stack from the browser (they can carry personal data).

const PAGE = '6a1f0e2d-3c4b-4a59-8e7f-001122334455';
const TURN = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
const capture = () => {
  const lines: LogEntry[] = [];
  const log = createLogger('alexa-sim', (entry) => lines.push(entry), { now: () => '2026-10-01T09:00:00.000Z', pageId: PAGE });
  return { lines, log };
};

describe('createLogger', () => {
  it('writes one shared log line with the code, its category and the turn correlation id', () => {
    const { lines, log } = capture();
    log({ level: 'warn', code: 'agent_unavailable', correlationId: TURN, details: { degraded: true } });
    expect(lines).toEqual([
      {
        ts: '2026-10-01T09:00:00.000Z',
        level: 'warn',
        component: 'alexa-sim',
        message: 'agent_unavailable',
        code: 'agent_unavailable',
        category: 'dependency_unavailable',
        correlationId: TURN,
        details: { degraded: true },
      },
    ]);
  });

  it('a line of no turn carries the page id', () => {
    const { lines, log } = capture();
    log({ level: 'info', code: 'phone_delivered' });
    expect(lines[0]).toEqual({ ts: '2026-10-01T09:00:00.000Z', level: 'info', component: 'alexa-sim', message: 'phone_delivered', correlationId: PAGE });
  });

  it('keeps only the name of an error, never its message', () => {
    const { lines, log } = capture();
    log({ level: 'error', code: 'unexpected_error', error: new TypeError('user said: my address is …') });
    expect(lines[0]).toMatchObject({ code: 'unexpected_error', category: 'internal', errorName: 'TypeError' });
    expect(JSON.stringify(lines[0])).not.toContain('address');
  });

  it('names a thrown non-error by its type', () => {
    const { lines, log } = capture();
    log({ level: 'error', code: 'unexpected_error', error: 'boom' });
    expect(lines[0]?.errorName).toBe('string');
  });

  it.each(Object.entries(HOST_EVENT_CODES))('logs the host event %s under the catalog code %s, the event as the message', (event, code) => {
    const { lines, log } = capture();
    log({ level: 'warn', code: event, correlationId: TURN });
    expect(lines[0]).toMatchObject({ message: event, code });
  });

  it('every line it writes is a valid LogEntry', () => {
    const { lines, log } = capture();
    log({ level: 'warn', code: 'frame_message_rejected', correlationId: TURN, details: { reason: 'too_large' } });
    log({ level: 'error', code: 'unexpected_error', error: new RangeError('x') });
    log({ level: 'info', code: 'phone_delivered', correlationId: TURN });
    log(voiceFailureEvent({ code: 'no_speech', phase: 'listening', turnId: null }));
    log(configErrorEvent(toolError('invalid_config', 'x')));
    // An unknown warning code still writes a valid line, as a bug of ours.
    log({ level: 'warn', code: 'not_a_code' });
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(LogEntrySchema.safeParse(line).success, JSON.stringify(line)).toBe(true);
    expect(lines[5]).toMatchObject({ message: 'not_a_code', code: 'unexpected_error' });
  });

  it('a sink that throws never breaks the caller', () => {
    const log = createLogger(
      'alexa-sim',
      () => {
        throw new Error('console gone');
      },
      { pageId: PAGE },
    );
    expect(() => {
      log({ level: 'warn', code: 'agent_unavailable' });
    }).not.toThrow();
  });
});

describe('the page logger', () => {
  it('writes to the console and to every added sink; a failing sink does not stop the others; the remover removes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: LogEntry[] = [];
    const removeBroken = addLogSink(() => {
      throw new Error('offline');
    });
    const remove = addLogSink((entry) => seen.push(entry));
    pageLog({ level: 'warn', code: 'agent_unavailable', correlationId: TURN });
    expect(seen).toEqual([expect.objectContaining({ code: 'agent_unavailable', correlationId: TURN })]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(LogEntrySchema.parse(JSON.parse(String(warn.mock.calls[0]?.[0])))).toMatchObject({ component: 'alexa-sim' });
    remove();
    removeBroken();
    pageLog({ level: 'warn', code: 'agent_unavailable', correlationId: TURN });
    expect(seen).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('logUnhandled', () => {
  it('logs an unhandled rejection and an uncaught error of the window as unexpected_error', () => {
    const target = new EventTarget();
    const log = vi.fn();
    const stop = logUnhandled(target, log);
    const rejection = Object.assign(new Event('unhandledrejection'), { reason: new RangeError('x') });
    target.dispatchEvent(rejection);
    target.dispatchEvent(Object.assign(new Event('error'), { error: new SyntaxError('y') }));
    expect(log.mock.calls).toEqual([
      [{ level: 'error', code: 'unexpected_error', error: rejection.reason, details: { source: 'unhandledrejection' } }],
      [{ level: 'error', code: 'unexpected_error', error: expect.any(SyntaxError) as unknown, details: { source: 'error' } }],
    ]);
    stop();
    target.dispatchEvent(rejection);
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('configErrorEvent (#125)', () => {
  it('logs the paths of the config issues, never their messages', () => {
    const error = toolError('invalid_config', 'The simulator configuration is invalid.', {
      details: { issues: [{ path: 'voice.listenTimeoutMs', message: 'Too small: 0' }, { path: 'homeTimeZone', message: 'Unknown IANA time zone' }] },
    });
    expect(configErrorEvent(error)).toEqual({ level: 'error', code: 'invalid_config', details: { step: 'config', issues: ['voice.listenTimeoutMs', 'homeTimeZone'] } });
    expect(configErrorEvent(toolError('invalid_config', 'x'))).toEqual({ level: 'error', code: 'invalid_config', details: { step: 'config', issues: [] } });
  });
});

describe('voiceFailureEvent (#133 review)', () => {
  it('logs a voice failure as an info line by code and phase, with the turn when there is one, never words', () => {
    expect(voiceFailureEvent({ code: 'mic_permission_denied', phase: 'listening', turnId: null })).toEqual({
      level: 'info',
      code: 'mic_permission_denied',
      details: { phase: 'listening' },
    });
    expect(voiceFailureEvent({ code: 'speech_start_missing', phase: 'speaking', turnId: 't9' })).toEqual({
      level: 'info',
      code: 'speech_start_missing',
      correlationId: 't9',
      details: { phase: 'speaking' },
    });
  });
});
