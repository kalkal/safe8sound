// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { celsius } from '@cold-reserve/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeRoomCard, safeRoomHeadline, clockOf, roomLabel } from '../src/SafeRoomCard.js';
import { safeRoomBatteryFirst, safeRoomCalm, safeRoomInStorm } from '../src/fixtures.js';
import { setTempUnit } from '../src/temp-unit.js';

afterEach(() => {
  cleanup();
  setTempUnit('C');
});

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

  it('#271: past the limit in force the card says so on its own strip, the big time keeps a neutral label, and it names the grandpa as Leo', () => {
    const above = { ...safeRoomCalm(), tempC: celsius(27), occupantRoles: ['grandpa'], people: [{ role: 'grandpa', name: 'Leo' }], limitNow: { limitC: celsius(24), kind: 'night' as const } };
    render(<SafeRoomCard status={above} />);
    expect(screen.getByTestId('over-limit').textContent).toContain('Above the night limit (24.0 °C) now');
    // Over the limit the time label never says "comfortable": it says what the time is, the battery's hold.
    expect(screen.getByText('The battery holds the room until')).toBeTruthy();
    expect(screen.queryByText('Comfortable at least until')).toBeNull();
    expect(screen.getByText('Who: Leo, grandpa')).toBeTruthy();
    cleanup();
    setTempUnit('F');
    render(<SafeRoomCard status={above} />);
    expect(screen.getByTestId('over-limit').textContent).toContain('Above the night limit (75.2 °F) now');
    cleanup();
    setTempUnit('C');
    render(<SafeRoomCard status={{ ...above, tempC: celsius(23) }} />);
    expect(screen.getByText('Comfortable at least until')).toBeTruthy();
    expect(screen.queryByTestId('over-limit')).toBeNull();
  });

  it('#114: with the store down, the time is at the stricter limit for an older or frail person and the card says it is the live reading only', () => {
    render(<SafeRoomCard status={{ ...safeRoomCalm(), storeUnavailable: true, stricterNightLimit: true }} />);
    expect(screen.getByText('At the stricter limit for an older or frail person, at least until')).toBeTruthy();
    expect(screen.queryByText('Comfortable at least until')).toBeNull();
    expect(screen.getByTestId('store-down').textContent).toBe('The saved settings and the storm state cannot be read right now: this is the live reading only.');
  });

  it('#342: with the store down in the heating season, the eyebrow is neutral: no older-person limit, no comfort promise', () => {
    render(<SafeRoomCard status={{ ...safeRoomCalm(), storeUnavailable: true }} />);
    expect(screen.getByText('From the live reading, at least until')).toBeTruthy();
    expect(screen.queryByText('At the stricter limit for an older or frail person, at least until')).toBeNull();
    expect(screen.queryByText('Comfortable at least until')).toBeNull();
    expect(screen.getByTestId('store-down')).toBeTruthy();
  });

  it('gives the hours as an estimate, "at least until", with the clock of the home', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    expect(screen.getByRole('region', { name: 'Safe room · Bedroom 1' })).toBeTruthy();
    expect(screen.getByText('Comfortable at least until')).toBeTruthy();
    expect(screen.getByTestId('safe-until').textContent).toBe('06:40');
    expect(screen.getByText('About 10½ h on the battery for this room.')).toBeTruthy();
  });

  it("#192: titles the room by the name the home profile gives it (the demo home's \"Leo's room\"), its id only without one", () => {
    render(<SafeRoomCard status={{ ...safeRoomInStorm(), safeRoomName: "Leo's room" }} />);
    expect(screen.getByRole('region', { name: "Safe room · Leo's room" })).toBeTruthy();
    expect(screen.queryByText(/Bedroom 1/)).toBeNull();
  });

  it('lists who is in the room, the measured air, and the level with its reason', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    const facts = screen.getByRole('list', { name: 'In the safe room', hidden: true });
    expect(facts.textContent).toContain('Who: grandpa');
    expect(facts.textContent).toContain('Now: 26.8 °C · 55% RH');
    expect(facts.textContent).toContain('Level: Essential (storm)');
  });

  it('°F everywhere (owner decision, 9 Oct): the measured air in the chosen unit', () => {
    setTempUnit('F');
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    expect(screen.getByRole('list', { name: 'In the safe room', hidden: true }).textContent).toContain('Now: 80.2 °F · 55% RH');
  });

  it('the ice cubes come right under the big time, before the facts (owner, 1 Oct: the signature element stays in the first view)', () => {
    const { container } = render(<SafeRoomCard status={safeRoomInStorm()} />);
    const hero = screen.getByTestId('safe-until');
    expect(hero.nextElementSibling?.classList.contains('cubes')).toBe(true);
    expect(container.querySelector('.cubes')?.compareDocumentPosition(screen.getByRole('list', { name: /./, hidden: true })) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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
    expect(screen.getByRole('list', { name: 'In the safe room', hidden: true }).textContent).toContain('Level: Comfort (your choice)');
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
    expect(screen.getByRole('list', { name: 'In the safe room', hidden: true }).textContent).toContain('Who: nobody right now');
  });
});

describe('SafeRoomCard when the battery runs out first (#364)', () => {
  it('the room time big, with its limit; the battery time below; the cubes still under the big time', () => {
    render(<SafeRoomCard status={safeRoomBatteryFirst()} />);
    const eyebrow = screen.getByText('Under 24 °C until about');
    const big = screen.getByTestId('safe-until');
    const battery = screen.getByTestId('battery-until');
    expect(big.textContent).toBe('06:00');
    expect(battery.textContent).toBe('The battery lasts until 03:05.');
    expect(eyebrow.compareDocumentPosition(big) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(big.compareDocumentPosition(battery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('Comfortable at least until')).toBeNull();
    // The cubes stay in the first view, right under the big time.
    expect(big.closest('.hero-row')?.querySelector('.cubes')).toBeTruthy();
    cleanup();
    setTempUnit('F');
    render(<SafeRoomCard status={safeRoomBatteryFirst()} />);
    expect(screen.getByText('Under 75.2 °F until about')).toBeTruthy();
  });

  it('inside its limits to the end of the projection: "at least until", no limit named', () => {
    const status = safeRoomBatteryFirst();
    render(<SafeRoomCard status={{ ...status, withinLimits: { until: '2026-07-18T20:00:00+02:00' } }} />);
    expect(screen.getByText('Within its limits at least until')).toBeTruthy();
    expect(screen.getByTestId('safe-until').textContent).toBe('20:00');
    expect(screen.getByTestId('battery-until').textContent).toBe('The battery lasts until 03:05.');
  });

  it('the 06:40 storm of the demo script is unchanged: no room time, the battery time big', () => {
    render(<SafeRoomCard status={safeRoomInStorm()} />);
    expect(screen.getByText('Comfortable at least until')).toBeTruthy();
    expect(screen.getByTestId('safe-until').textContent).toBe('06:40');
    expect(screen.queryByTestId('battery-until')).toBeNull();
  });
});

describe('safeRoomHeadline', () => {
  it('is the time and the meaning of the big time, for every place that shows it (review of #458)', () => {
    const calm = safeRoomCalm();
    expect(safeRoomHeadline(calm)).toEqual({ until: calm.safeUntil, kind: 'safe' });
    expect(safeRoomHeadline({ ...calm, withinLimits: { until: '2026-07-18T06:00:00+02:00' } })).toEqual({ until: '2026-07-18T06:00:00+02:00', kind: 'within' });
    expect(safeRoomHeadline({ ...calm, tempC: celsius(27), limitNow: { limitC: celsius(24), kind: 'night' } })).toEqual({ until: calm.safeUntil, kind: 'held' });
  });
});
