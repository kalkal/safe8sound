// @vitest-environment jsdom
import { HomeStatusSchema } from '@cold-reserve/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BATTERY_CHARGE_WIDTH } from '../src/DeviceIcon.js';
import { FloorPlanCard } from '../src/FloorPlanCard.js';
import { homeCalm, homeInStorm } from '../src/home-fixtures.js';
import { setTempUnit } from '../src/temp-unit.js';

afterEach(() => {
  cleanup();
  setTempUnit('C');
});

describe('FloorPlanCard (signature element 3: the thermal floor plan, generated from the home)', () => {
  it('draws one tile per room, generated from the status, never by hand', () => {
    render(<FloorPlanCard status={homeInStorm()} />);
    const plan = screen.getByRole('list', { name: 'Rooms', hidden: true });
    expect(within(plan).getAllByRole('listitem', { hidden: true })).toHaveLength(homeInStorm().rooms.length);
  });

  it('says for each room whether it is served, or waiting and why, in words', () => {
    render(<FloorPlanCard status={homeInStorm()} />);
    const bedroom = screen.getByRole('listitem', { name: 'Bedroom 1', hidden: true });
    expect(bedroom.textContent).toContain('Served');
    expect(bedroom.textContent).toContain('26.8 °C');
    expect(bedroom.textContent).toContain('grandpa');
    const living = screen.getByRole('listitem', { name: 'Living', hidden: true });
    expect(living.textContent).toContain('Waiting: the level cools fewer rooms right now');
  });

  it('°F everywhere (owner decision, 9 Oct): each room in the chosen unit', () => {
    setTempUnit('F');
    render(<FloorPlanCard status={homeInStorm()} />);
    expect(screen.getByRole('listitem', { name: 'Bedroom 1', hidden: true }).textContent).toContain('80.2 °F');
    expect(screen.getByRole('list', { name: 'Rooms', hidden: true }).textContent).not.toContain('°C');
  });

  it('says the battery feeds only the safe room while the grid is down', () => {
    render(<FloorPlanCard status={homeInStorm()} />);
    expect(screen.getByText('Grid down: the battery feeds the safe room only.')).toBeTruthy();
    cleanup();
    render(<FloorPlanCard status={{ ...homeInStorm(), gridAvailable: true }} />);
    expect(screen.queryByText(/Grid down/)).toBeNull();
  });

  it('#204: lists the battery, the solar, the grid and the level in words, beside the rooms', () => {
    render(<FloorPlanCard status={homeInStorm()} />);
    const energy = screen.getByRole('list', { name: 'Energy' });
    expect(within(energy).getAllByRole('listitem').map((i) => i.textContent)).toEqual(['Battery 48%', 'Solar 0.0 kW', 'Grid down', 'Level: Essential (storm)']);
    cleanup();
    render(<FloorPlanCard status={homeCalm()} />);
    expect(within(screen.getByRole('list', { name: 'Energy' })).getAllByRole('listitem').map((i) => i.textContent)).toEqual([
      'Battery 78%',
      'Solar 3.2 kW',
      'Grid: sending 1.1 kW',
      'Level: Comfort (weather)',
    ]);
    cleanup();
    render(<FloorPlanCard status={HomeStatusSchema.parse({ ...homeCalm(), gridW: 400 })} />);
    expect(screen.getByText('Grid: taking 0.4 kW')).toBeTruthy();
  });

  it('owner feedback (6 Oct): each energy device has its own big icon, the battery drawn at its level; the words stay', () => {
    const { container } = render(<FloorPlanCard status={homeCalm()} />);
    const devices = [...container.querySelectorAll('.energy-facts li')].map((li) => li.querySelector('svg')?.getAttribute('data-device'));
    expect(devices).toEqual(['battery', 'solar', 'grid', undefined]);
    expect(container.querySelector('svg[data-device="battery"] [data-level]')?.getAttribute('data-level')).toBe('78');
    // Drawings beside words that already say everything: screen readers read the words once.
    for (const svg of container.querySelectorAll('svg[data-device]')) expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Battery 78%')).toBeTruthy();
  });

  it('review of #286: the battery fill follows the charge (78 % and 48 % differ, in proportion)', () => {
    const fill = (status: Parameters<typeof FloorPlanCard>[0]['status']) => {
      const { container } = render(<FloorPlanCard status={status} />);
      const w = Number(container.querySelector('svg[data-device="battery"] [data-level]')?.getAttribute('width'));
      cleanup();
      return w;
    };
    const full = fill(homeCalm());
    const storm = fill(homeInStorm());
    expect(full).toBeCloseTo((BATTERY_CHARGE_WIDTH * 78) / 100);
    expect(storm).toBeCloseTo((BATTERY_CHARGE_WIDTH * 48) / 100);
  });

  it('review of #286: no sun at 0 W of solar, and the pylon crossed out while the grid is down', () => {
    const { container } = render(<FloorPlanCard status={homeInStorm()} />);
    expect(container.querySelector('svg[data-device="solar"]')?.getAttribute('data-on')).toBe('false');
    expect(container.querySelector('svg[data-device="solar"] .device-sun')).toBeNull();
    expect(container.querySelector('svg[data-device="grid"]')?.getAttribute('data-on')).toBe('false');
    expect(container.querySelector('svg[data-device="grid"] .device-cross')).not.toBeNull();
    cleanup();
    const calm = render(<FloorPlanCard status={homeCalm()} />).container;
    expect(calm.querySelector('svg[data-device="solar"] .device-sun')).not.toBeNull();
    expect(calm.querySelector('svg[data-device="grid"] .device-cross')).toBeNull();
  });

  it('owner feedback (6 Oct): every room shows its split, blowing when the room is served and still when it waits', () => {
    const { container } = render(<FloorPlanCard status={homeCalm()} />);
    const splits = [...container.querySelectorAll('.room-tile')].map((tile) => tile.querySelector('svg[data-device="split"]')?.getAttribute('data-on'));
    expect(splits).toEqual(['true', 'false', 'true', 'false']);
  });

  it('shows the data origin', () => {
    render(<FloorPlanCard status={homeInStorm()} />);
    expect(screen.getByTestId('origin-badge').textContent).toContain('SIMULATED');
  });
});
