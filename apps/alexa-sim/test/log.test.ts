import { describe, expect, it, vi } from 'vitest';
import { createLogger, logUnhandled, type LogLine } from '../src/log.js';

// One JSON line per event, in the fields of the shared log entry (audit L1/L6): never plain text,
// never a message or a stack from the browser (they can carry personal data).

const capture = () => {
  const lines: LogLine[] = [];
  const log = createLogger('alexa-sim', (line) => lines.push(JSON.parse(line) as LogLine), () => '2026-10-01T09:00:00.000Z');
  return { lines, log };
};

describe('createLogger', () => {
  it('writes one JSON line with the category of a catalog code and the correlation id', () => {
    const { lines, log } = capture();
    log({ level: 'warn', code: 'agent_unavailable', correlationId: 'turn-1', details: { degraded: true } });
    expect(lines).toEqual([
      { ts: '2026-10-01T09:00:00.000Z', level: 'warn', component: 'alexa-sim', code: 'agent_unavailable', category: 'dependency_unavailable', correlationId: 'turn-1', details: { degraded: true } },
    ]);
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

  it('writes a host-only code without a category', () => {
    const { lines, log } = capture();
    log({ level: 'warn', code: 'frame_message_rejected', details: { reason: 'too_large' } });
    expect(lines[0]).toEqual({ ts: '2026-10-01T09:00:00.000Z', level: 'warn', component: 'alexa-sim', code: 'frame_message_rejected', details: { reason: 'too_large' } });
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
