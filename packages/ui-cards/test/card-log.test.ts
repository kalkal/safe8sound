import { describe, expect, it, vi } from 'vitest';
import { createCardLogger, logUnhandled } from '../src/app/card-log.js';

// The card frame logs like the host (audit L6): one JSON line, error name only, no message or stack.

describe('createCardLogger', () => {
  it('writes one JSON line with the category and the error name', () => {
    const lines: string[] = [];
    const log = createCardLogger((line) => lines.push(line), () => '2026-10-01T09:00:00.000Z');
    log({ level: 'warn', code: 'unexpected_error', error: new TypeError('private'), details: { tool: 'apply_plan' } });
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { ts: '2026-10-01T09:00:00.000Z', level: 'warn', component: 'ui-cards', code: 'unexpected_error', category: 'internal', errorName: 'TypeError', details: { tool: 'apply_plan' } },
    ]);
  });
});

describe('logUnhandled', () => {
  it('logs an unhandled rejection in the frame', () => {
    const target = new EventTarget();
    const log = vi.fn();
    logUnhandled(target, log);
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'x' }));
    expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'error', code: 'unexpected_error', error: 'x', details: { source: 'unhandledrejection' } });
  });
});
