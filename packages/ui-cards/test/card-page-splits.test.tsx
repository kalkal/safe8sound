// @vitest-environment jsdom
import { ReserveOutlookSchema } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FloorPlanCard } from '../src/FloorPlanCard.js';
import { IceCubesCard } from '../src/IceCubesCard.js';
import { PlanCard } from '../src/PlanCard.js';
import { SafeRoomCard } from '../src/SafeRoomCard.js';
import { homeCalm } from '../src/home-fixtures.js';
import { hotDayPlan, lastResortPlan, safeRoomInStorm, surplusPlan } from '../src/fixtures.js';

// One giant number per view, pages instead of scrolling (owner, 10 Oct): each card's first page carries its giant
// number, with the ice cubes or the one accent button; the rest goes to the next pages.

afterEach(cleanup);
const pageOf = (el: Element) => el.closest('[data-page]')?.getAttribute('data-page');

describe('first pages', () => {
  it('plan: the time and Apply on page 1; the levels and the battery line on later pages; the receipt last', () => {
    const { container } = render(<PlanCard plan={hotDayPlan()} timeZone="Europe/Rome" onApply={vi.fn()} extraPages={[<p key="r">receipt</p>]} />);
    expect(pageOf(screen.getByTestId('plan-horizon'))).toBe('1');
    expect(pageOf(screen.getByRole('button', { name: 'Apply plan' }))).toBe('1');
    const later = [...container.querySelectorAll('[data-page]')].slice(1);
    expect(later.length).toBeGreaterThanOrEqual(2);
    expect(pageOf(screen.getByText('receipt'))).toBe(String(later.length + 1));
  });

  it('a last resort and an ordinary day keep their own headline on page 1', () => {
    render(<PlanCard plan={lastResortPlan()} timeZone="Europe/Rome" onApply={vi.fn()} />);
    expect(pageOf(screen.getByTestId('last-resort-window'))).toBe('1');
    cleanup();
    render(<PlanCard plan={surplusPlan()} timeZone="Europe/Rome" />);
    expect(pageOf(screen.getByTestId('surplus-kept'))).toBe('1');
  });

  it('safe room: the storm, the time and the ice cubes on page 1; the facts on page 2', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    expect(pageOf(screen.getByRole('alert'))).toBe('1');
    expect(pageOf(screen.getByTestId('safe-until'))).toBe('1');
    expect(pageOf(screen.getByRole('img'))).toBe('1');
    expect(pageOf(screen.getByRole('list', { hidden: true }))).toBe('2');
  });

  it('cold reserve: the hours and the ice cubes on page 1; how they are counted on page 2', () => {
    render(<IceCubesCard outlook={ReserveOutlookSchema.parse(exampleReserveOutlook())} />);
    expect(pageOf(screen.getByTestId('cube-hours'))).toBe('1');
    expect(pageOf(screen.getByRole('img'))).toBe('1');
    expect(pageOf(screen.getByText(/One cube is one hour/))).toBe('2');
  });

  it('home: the energy on page 1, the rooms on page 2', () => {
    render(<FloorPlanCard status={homeCalm()} />);
    expect(pageOf(screen.getByRole('list', { name: 'Energy' }))).toBe('1');
    expect(pageOf(screen.getByRole('list', { name: 'Rooms', hidden: true }))).toBe('2');
  });
});
