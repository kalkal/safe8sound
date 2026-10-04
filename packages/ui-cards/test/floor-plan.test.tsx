// @vitest-environment jsdom
import { HomeStatusSchema } from '@cold-reserve/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FloorPlanCard } from '../src/FloorPlanCard.js';
import { homeCalm, homeInStorm } from '../src/home-fixtures.js';

afterEach(cleanup);

describe('FloorPlanCard (signature element 3: the thermal floor plan, generated from the home)', () => {
  it('draws one tile per room, generated from the status, never by hand', () => {
    render(<FloorPlanCard status={homeInStorm()} />);
    const plan = screen.getByRole('list', { name: 'Rooms' });
    expect(within(plan).getAllByRole('listitem')).toHaveLength(homeInStorm().rooms.length);
  });

  it('says for each room whether it is served, or waiting and why, in words', () => {
    render(<FloorPlanCard status={homeInStorm()} />);
    const bedroom = screen.getByRole('listitem', { name: 'Bedroom 1' });
    expect(bedroom.textContent).toContain('Served');
    expect(bedroom.textContent).toContain('26.8 °C');
    expect(bedroom.textContent).toContain('grandpa');
    const living = screen.getByRole('listitem', { name: 'Living' });
    expect(living.textContent).toContain('Waiting: the level cools fewer rooms right now');
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

  it('shows the data origin', () => {
    render(<FloorPlanCard status={homeInStorm()} />);
    expect(screen.getByTestId('origin-badge').textContent).toContain('SIMULATED');
  });
});
