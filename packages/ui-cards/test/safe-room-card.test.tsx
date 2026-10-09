// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeRoomCard, clockOf, roomLabel } from '../src/SafeRoomCard.js';
import { safeRoomCalm, safeRoomInStorm } from '../src/fixtures.js';
import { setTempUnit } from '../src/temp-unit.js';

afterEach(cleanup);

describe('clockOf and roomLabel', () => {
  it('reads the clock time from a time already in the home zone, never converting it', () => {
    expect(clockOf('2026-07-18T06:40:00+02:00')).toBe('06:40');
    expect(clockOf('2026-01-17T21:05:00+01:00')).toBe('21:05');
  });

  it('names a room from its id when there is no name', () => {
    expect(roomLabel('bedroom-1')).toBe('Bedroom 1');
    expect(roomLabel('living')).toBe('Living');
  });
});

describe('SafeRoomCard', () => {
  it('in a storm: says "Storm mode" in words with an icon, once, assertively', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toMatch(/Storm mode · the grid is down$/);
    expect(banner.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('announces the storm once: at Essential there is still a single assertive message (row 10 of the design review)', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    expect(safeRoomInStorm().level).toBe('essential');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('gives the hours as an estimate, "at least until", with the clock of the home', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    expect(screen.getByRole('region', { name: 'Safe room · Bedroom 1' })).toBeTruthy();
    expect(screen.getByText('Comfortable at least until')).toBeTruthy();
    expect(screen.getByTestId('safe-until').textContent).toBe('06:40');
    expect(screen.getByText('About 10½ h on the battery for this room.')).toBeTruthy();
  });

  it('lists who is in the room, the measured air, and the level with its reason', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    const facts = screen.getByRole('list', { name: 'In the safe room' });
    expect(facts.textContent).toContain('Who: grandpa');
    expect(facts.textContent).toContain('Now: 26.8 °C · 55% RH');
    expect(facts.textContent).toContain('Level: Essential (storm)');
  });

  it('°F everywhere (owner decision, 9 Oct): the measured air in the chosen unit', () => {
    setTempUnit('F');
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    expect(screen.getByRole('list', { name: 'In the safe room' }).textContent).toContain('Now: 80.2 °F · 55% RH');
    setTempUnit('C');
  });

  it('draws the hours as ice cubes, described in words', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    expect(screen.getByRole('img', { name: '10½ hours: 10 full cubes and part of one more.' })).toBeTruthy();
  });

  it('in the storm, the cube of the hour being used empties once, from full to what is left of it (video, scene 3)', () => {
    const { container } = render(<SafeRoomCard status={safeRoomInStorm()} />);
    const cubes = [...container.querySelectorAll<HTMLElement>('.cube')];
    const melting = cubes.filter((c) => c.dataset['melting'] === 'true');
    expect(melting).toHaveLength(1);
    // 10.4 hours: ten full cubes, and the eleventh is the hour now being used.
    expect(cubes.indexOf(melting[0] as HTMLElement)).toBe(10);
    expect(Number(melting[0]?.dataset['fill'])).toBeCloseTo(0.4);
  });

  it('no cube empties outside the storm', () => {
    const { container } = render(<SafeRoomCard status={safeRoomCalm()} />);
    expect(container.querySelectorAll('.cube[data-melting="true"]')).toHaveLength(0);
  });

  it('tells what to do during the storm, and nothing alarming outside it', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    expect(screen.getByText('Stay in the safe room and keep the door closed.')).toBeTruthy();
    cleanup();
    render(<SafeRoomCard status={safeRoomCalm()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/keep the door closed/)).toBeNull();
    expect(screen.getByRole('list', { name: 'In the safe room' }).textContent).toContain('Level: Comfort (your choice)');
  });

  it('shows the data origin, and an information strip when the home link is not ok', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    expect(screen.getByTestId('origin-badge').textContent).toContain('SIMULATED');
    expect(screen.queryByTestId('home-link')).toBeNull();
    cleanup();
    render(<SafeRoomCard status={{ ...safeRoomInStorm(), homeLink: 'stale' }} />);
    expect(screen.getByTestId('home-link').textContent).toBe('The home has not sent a fresh reading: these are the last known values.');
  });

  it('says when nobody is in the room', () => {
    render(<SafeRoomCard status={{ ...safeRoomCalm(), occupantRoles: [] }} />);
    expect(screen.getByRole('list', { name: 'In the safe room' }).textContent).toContain('Who: nobody right now');
  });
});
