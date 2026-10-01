// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/ui/ErrorBoundary.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new RangeError('secret detail');
}

/** Our own JSON lines among console.error calls (React logs caught errors there too). */
const jsonLines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.flatMap(([first]) => {
    try {
      return typeof first === 'string' ? [JSON.parse(first) as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });

it('logs a broken surface as one JSON line with the error name only, and shows a calm message', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>,
  );
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(jsonLines(spy)).toEqual([expect.objectContaining({ level: 'error', component: 'alexa-sim', code: 'unexpected_error', category: 'internal', errorName: 'RangeError' })]);
  expect(JSON.stringify(jsonLines(spy))).not.toContain('secret');
});
