// @vitest-environment jsdom
import { ReserveOutlookSchema } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { cubeFills, cubesLabel } from '@cold-reserve/ui-cards';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReserveClock } from '../../src/ui/ReserveClock.js';

// The cold reserve clock (owner, 11 Oct): on the idle screen, the row of ice cubes of the current reserve, the same
// 56 px cubes as the cards; in the storm the cube of the hour being used melts, as on the safe-room card.

afterEach(cleanup);
const outlook = ReserveOutlookSchema.parse(exampleReserveOutlook());
const hours = outlook.hoursAtCurrentLevel;

describe('ReserveClock', () => {
  it('says the hours and draws one cube per hour, described in words', () => {
    const { container } = render(<ReserveClock outlook={outlook} storm={false} />);
    const region = screen.getByRole('region', { name: 'Cold reserve' });
    expect(region.textContent).toContain('9½ h');
    expect(screen.getByRole('img', { name: cubesLabel(hours) })).toBeTruthy();
    expect(container.querySelectorAll('.cube')).toHaveLength(cubeFills(hours).length);
    expect(container.querySelector('[data-melting]')).toBeNull();
  });

  it('in the storm the cube of the hour being used melts, and only that one', () => {
    const { container } = render(<ReserveClock outlook={outlook} storm />);
    const melting = container.querySelectorAll('[data-melting="true"]');
    expect(melting).toHaveLength(1);
    expect([...container.querySelectorAll('.cube')].indexOf(melting[0] as Element)).toBe(Math.floor(hours));
  });

  it('the offline example says so under the title; the real reserve does not (option B, 20 Oct)', () => {
    const { rerender } = render(<ReserveClock outlook={outlook} storm={false} example />);
    const region = screen.getByRole('region', { name: 'Cold reserve' });
    expect(region.textContent).toContain('Offline example');
    // Outside the uppercase title: it reads "Offline example" as everywhere else (review of #479), and the hours keep their cell.
    expect(region.querySelector('h2 [data-testid="offline-example"]')).toBeNull();
    expect(region.querySelector('.reserve-hours [data-testid="offline-example"]')).toBeNull();
    rerender(<ReserveClock outlook={outlook} storm={false} />);
    expect(screen.getByRole('region', { name: 'Cold reserve' }).textContent).not.toContain('Offline example');
  });
});

describe('the hours if the power goes now (owner, 22 Oct: "0 h" with a full storm reserve)', () => {
  it('counts the whole battery at Essential, says so under the title, and draws a cube per hour', () => {
    const all = ReserveOutlookSchema.parse({ ...exampleReserveOutlook(), hoursAtCurrentLevel: 0, hoursAtEssential: 0, hoursIfOutageNow: 8, gridAvailable: true });
    const { container } = render(<ReserveClock outlook={all} storm={false} />);
    const region = screen.getByRole('region', { name: 'Cold reserve' });
    expect(region.textContent).toContain('If the power goes now');
    expect(region.textContent).toContain('8 h');
    expect(container.querySelectorAll('.cube')).toHaveLength(cubeFills(8).length);
  });
});

describe('the label follows the grid (review of #522)', () => {
  it('with the grid down the hours are the battery now, never "if the power goes now"', () => {
    const down = ReserveOutlookSchema.parse({ ...exampleReserveOutlook(), hoursAtCurrentLevel: 2.5, hoursAtEssential: 8.7, hoursIfOutageNow: 8.7, gridAvailable: false });
    render(<ReserveClock outlook={down} storm />);
    const region = screen.getByRole('region', { name: 'Cold reserve' });
    expect(region.textContent).toContain('On the battery now, at Essential');
    expect(region.textContent).not.toContain('If the power goes now');
  });
});
