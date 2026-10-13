// @vitest-environment jsdom
import { setLocale } from '@cold-reserve/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimClock } from '../../src/ui/SimClock.js';
import type { ClockState } from '../../src/ui/sim-clock.js';

afterEach(() => {
  cleanup();
  setLocale('en-US');
});

// The simulated clock above the device (time pack, 12 Oct): the time marked SIMULATED, one line on what happened or
// what comes next, and one quiet "Skip ahead" button, disabled while it moves or with nothing ahead.

const AHEAD: ClockState = { now: '2026-07-18T12:00:00+02:00', next: { kind: 'storm_start', at: '2026-07-18T15:00:00+02:00', label: 'The storm starts: the grid goes down' } };

describe('SimClock', () => {
  it('says the simulated time and the next moment; Skip ahead is a quiet button that skips', () => {
    const onSkip = vi.fn();
    render(<SimClock state={AHEAD} busy={false} onSkip={onSkip} />);
    const clock = screen.getByRole('group', { name: 'Simulated time' });
    expect(clock.textContent).toContain('SIMULATED');
    expect(clock.querySelector('time')?.textContent).toBe('12:00');
    expect(within(clock).getByRole('status').textContent).toBe('Next: the grid goes down at 15:00');
    const skip = within(clock).getByRole('button', { name: /Skip ahead/ });
    // Quiet: a chip, never the bright `.button` (one bright action per screen).
    expect(skip.classList.contains('button')).toBe(false);
    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('what just happened wins over what comes next: the grid down, a moment reached, a failed move', () => {
    const { rerender } = render(<SimClock state={AHEAD} note={{ kind: 'grid_down' }} busy={false} onSkip={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('The simulated grid is now down.');
    rerender(<SimClock state={AHEAD} note={{ kind: 'reached', moment: 'essential_level' }} busy={false} onSkip={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('Now: the battery reaches the essential level.');
    rerender(<SimClock state={AHEAD} note={{ kind: 'failed' }} busy={false} onSkip={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe("The clock didn't move. Try again.");
    rerender(<SimClock state={AHEAD} note={{ kind: 'limit' }} busy={false} onSkip={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('The clock has moved enough for today: it can move again tomorrow.');
  });

  it('disabled while moving and with nothing ahead, and says why', () => {
    const { rerender } = render(<SimClock state={AHEAD} busy onSkip={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Skip ahead/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toBe('Moving the clock…');
    rerender(<SimClock state={{ now: AHEAD.now }} busy={false} onSkip={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Skip ahead/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toBe('Nothing more to skip to today.');
  });

  it('in Italian', () => {
    setLocale('it-IT');
    render(<SimClock state={AHEAD} busy={false} onSkip={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Ora simulata' }).textContent).toContain('SIMULATO');
    expect(screen.getByRole('button', { name: /Vai avanti/ })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Prossimo: la rete si spegne alle 15:00');
  });
});
