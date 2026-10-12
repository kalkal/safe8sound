// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CardErrorBoundary, CardFailed } from '../src/app/CardErrorBoundary.js';

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

it('logs a broken card as one JSON line with the error name only, and shows a calm message', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <CardErrorBoundary>
      <Broken />
    </CardErrorBoundary>,
  );
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(jsonLines(spy)).toEqual([expect.objectContaining({ level: 'error', component: 'ui-cards', code: 'unexpected_error', category: 'internal', errorName: 'RangeError' })]);
  expect(JSON.stringify(jsonLines(spy))).not.toContain('secret');
});

it('the failed card is still a card: inline it offers no "Full screen"; in full screen it keeps "Back" and Escape (#356)', () => {
  const toggle = vi.fn();
  render(<CardFailed display={{ canFullscreen: true, fullscreen: false, toggle }} />);
  expect(screen.getByRole('alert').textContent).toBe('This card could not be shown.');
  expect(screen.getByRole('region', { name: 'Something went wrong' })).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  cleanup();
  render(<CardFailed display={{ canFullscreen: true, fullscreen: true, toggle }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Back to the conversation' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(toggle).toHaveBeenCalledTimes(2);
  cleanup();
  // The bridge never connected (main.tsx): no display control yet, still the same card.
  render(<CardFailed />);
  expect(screen.getByRole('alert').textContent).toBe('This card could not be shown.');
});
