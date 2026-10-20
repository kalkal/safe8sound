// @vitest-environment jsdom
import { celsius, type InboxMessage, type Milestone } from '@cold-reserve/contracts';
import { setLocale } from '@cold-reserve/i18n';
import { safeRoomCalm } from '@cold-reserve/ui-cards';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IdleTiles, ScreenTop, greetingOf, useNotices } from '../../src/idle/IdleScreen.js';
import { createScriptedPhone } from '../../src/phone/phone-feed.js';

// The realistic Echo Show screen (#432 S6, owner 18 Oct; confronto-echo-show §1.1, §1.7): the top row of the real
// Alexa+ home (the menu and the notification bell top left, the time and the weather top right) and the translucent
// tiles at rest: Leo's room with the time it stays safe until (read from the server, D2 = b), the cold reserve, the
// next moment of the day, and a new message to Ana while it is unseen (our addition: the real bell has no such line).

afterEach(() => {
  cleanup();
  setLocale('en-US');
});

const storm: InboxMessage = { at: '2026-07-17T15:00:00+02:00', role: 'daughter', channel: 'in_app', transition: 'storm_started', text: 'Power outage at home.' };
const next: Milestone = { at: '2026-07-17T21:00:00+02:00', kind: 'essential_level', label: 'Essential level' };

describe('ScreenTop', () => {
  it('shows the time on the home clock and the weather the sky says, with the menu and the bell', () => {
    render(<ScreenTop now="2026-07-17T15:00:00+02:00" sky="storm" unseen={0} onSeen={() => undefined} menu={<button type="button">Show my home</button>} />);
    expect(screen.getByTestId('screen-time').textContent).toBe('15:00');
    expect(screen.getByTestId('screen-weather').textContent).toBe('Storm');
    expect(screen.getByRole('button', { name: 'Notifications' }).dataset['new']).toBe('false');
    expect(screen.queryByRole('button', { name: 'Show my home' })).toBeNull();
  });

  it('names each sky as weather, in both languages', () => {
    const words = (['mild', 'hot', 'dusk', 'storm'] as const).map((sky) => {
      render(<ScreenTop now="2026-07-17T12:00:00+02:00" sky={sky} unseen={0} onSeen={() => undefined} menu={null} />);
      const word = screen.getByTestId('screen-weather').textContent;
      cleanup();
      return word;
    });
    expect(words).toEqual(['Sunny', 'Hot', 'Warm evening', 'Storm']);
    setLocale('it-IT');
    render(<ScreenTop now="2026-07-17T12:00:00+02:00" sky="storm" unseen={0} onSeen={() => undefined} menu={null} />);
    expect(screen.getByTestId('screen-weather').textContent).toBe('Temporale');
  });

  it('the menu opens its list and closes with Escape or after a choice', () => {
    render(<ScreenTop now="2026-07-17T12:00:00+02:00" sky="mild" unseen={0} onSeen={() => undefined} menu={<button type="button">Show my home</button>} />);
    const menu = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Show my home' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Show my home' })).toBeNull();
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    expect(screen.queryByRole('button', { name: 'Show my home' })).toBeNull();
    expect(menu.getAttribute('aria-expanded')).toBe('false');
  });

  it('the bell has a dot while a message is unseen, and a touch marks it seen', () => {
    let seen = 0;
    render(<ScreenTop now="2026-07-17T15:00:00+02:00" sky="storm" unseen={1} onSeen={() => (seen += 1)} menu={null} />);
    const bell = screen.getByRole('button', { name: 'Notifications · 1 new' });
    expect(bell.dataset['new']).toBe('true');
    fireEvent.click(bell);
    expect(seen).toBe(1);
  });
});

describe('IdleTiles', () => {
  it("Leo's room with his drawn avatar and the time it stays safe until, the reserve, and the next moment", () => {
    const room = { ...safeRoomCalm(), safeRoomName: "Leo's room", safeUntil: '2026-07-18T06:40:00+02:00' };
    render(<IdleTiles room={room} reserve={<p>9½ h</p>} next={next} notice={undefined} timeZone="Europe/Rome" />);
    const tile = screen.getByTestId('tile-safe-room');
    expect(within(tile).getByText("Leo's room")).toBeTruthy();
    expect(within(tile).getByText('Safe until 06:40')).toBeTruthy();
    expect(tile.querySelector('svg[data-avatar="older-man"]')).not.toBeNull();
    expect(within(screen.getByTestId('tile-reserve')).getByText('9½ h')).toBeTruthy();
    expect(screen.getByTestId('tile-next').textContent).toBe('Next · 21:00The home steps down to its essential settings');
    expect(screen.queryByTestId('tile-notice')).toBeNull();
  });

  it("says what the safe room card says: the room's own limits time, or the battery's hold past the limit (review of #458)", () => {
    const base = { ...safeRoomCalm(), safeRoomName: "Leo's room", safeUntil: '2026-07-18T03:05:00+02:00' };
    const { unmount } = render(<IdleTiles room={{ ...base, withinLimits: { until: '2026-07-18T06:00:00+02:00', limitC: celsius(24) } }} reserve={undefined} next={undefined} notice={undefined} timeZone="Europe/Rome" />);
    expect(within(screen.getByTestId('tile-safe-room')).getByText('Within its limits until about 06:00')).toBeTruthy();
    unmount();
    const above = { ...base, tempC: celsius(27), limitNow: { limitC: celsius(24), kind: 'night' as const } };
    render(<IdleTiles room={above} reserve={undefined} next={undefined} notice={undefined} timeZone="Europe/Rome" />);
    expect(within(screen.getByTestId('tile-safe-room')).getByText('Battery holds it until 03:05')).toBeTruthy();
  });

  it('the clear day at 12:00: safe at least until 12:00 tomorrow, never "until" the hour it is now', () => {
    const room = { ...safeRoomCalm(), safeRoomName: "Leo's room", safeUntilCapped: true as const, safeHours: 24, safeUntil: '2026-07-16T12:00:00+02:00' };
    const { unmount } = render(<IdleTiles room={room} reserve={undefined} next={undefined} notice={undefined} timeZone="Europe/Rome" />);
    expect(within(screen.getByTestId('tile-safe-room')).getByText('Safe at least until 12:00 tomorrow')).toBeTruthy();
    unmount();
    setLocale('it-IT');
    render(<IdleTiles room={room} reserve={undefined} next={undefined} notice={undefined} timeZone="Europe/Rome" />);
    expect(within(screen.getByTestId('tile-safe-room')).getByText('Al sicuro almeno fino alle 12:00 di domani')).toBeTruthy();
  });

  it('#459: a room that never crosses its limits in the projection is "at least", as on the card, in both languages', () => {
    const room = { ...safeRoomCalm(), safeRoomName: "Leo's room", safeUntil: '2026-07-18T03:05:00+02:00', withinLimits: { until: '2026-07-18T06:00:00+02:00' } };
    const { unmount } = render(<IdleTiles room={room} reserve={undefined} next={undefined} notice={undefined} timeZone="Europe/Rome" />);
    expect(within(screen.getByTestId('tile-safe-room')).getByText('Within its limits at least until 06:00')).toBeTruthy();
    unmount();
    setLocale('it-IT');
    render(<IdleTiles room={room} reserve={undefined} next={undefined} notice={undefined} timeZone="Europe/Rome" />);
    expect(within(screen.getByTestId('tile-safe-room')).getByText('Nei suoi limiti almeno fino alle 06:00')).toBeTruthy();
  });

  it('leaves out a tile whose reading is missing (a failed read, the end of the day), never an empty box', () => {
    render(<IdleTiles room={undefined} reserve={undefined} next={undefined} notice={undefined} timeZone="Europe/Rome" />);
    expect(screen.queryByTestId('tile-safe-room')).toBeNull();
    expect(screen.queryByTestId('tile-reserve')).toBeNull();
    expect(screen.queryByTestId('tile-next')).toBeNull();
  });

  it('a new message to Ana comes first, with what it says and when, until it is seen', () => {
    render(<IdleTiles room={undefined} reserve={undefined} next={undefined} notice={storm} timeZone="Europe/Rome" />);
    expect(screen.getByTestId('tile-notice').textContent).toBe('Message to Ana · 15:00Power outage (storm) at home');
  });
});

describe('greetingOf', () => {
  // The real Alexa+ home opens with one large personal sentence (confronto §1.1): ours greets Leo by the part of the
  // day on the home's clock, by his fictional name when the sandbox gives it, and plainly without one.
  it('greets by the part of the day on the home clock, with the name the sandbox gives', () => {
    const room = { ...safeRoomCalm(), people: [{ role: 'grandpa', name: 'Leo' }] };
    expect(greetingOf('2026-07-17T08:00:00+02:00', room)).toBe('Good morning, Leo.');
    expect(greetingOf('2026-07-17T15:00:00+02:00', room)).toBe('Good afternoon, Leo.');
    expect(greetingOf('2026-07-17T19:42:00+02:00', room)).toBe('Good evening, Leo.');
    expect(greetingOf('2026-07-18T03:00:00+02:00', room)).toBe('Good evening, Leo.');
    expect(greetingOf('2026-07-17T15:00:00+02:00', safeRoomCalm())).toBe('Good afternoon.');
  });

  it('without a simulated clock there is no greeting (the first screen says what to ask)', () => {
    expect(greetingOf(undefined, safeRoomCalm())).toBeUndefined();
  });
});

describe('useNotices', () => {
  it('counts the messages Ana got since the bell was last touched; a new play of the day starts again', () => {
    const phone = createScriptedPhone();
    const { result } = renderHook(() => useNotices(phone));
    expect(result.current.unseen).toBe(0);
    act(() => {
      phone.deliver([storm]);
    });
    expect(result.current.unseen).toBe(1);
    expect(result.current.newest).toEqual(storm);
    act(() => {
      result.current.markSeen();
    });
    expect(result.current.unseen).toBe(0);
    expect(result.current.newest).toBeUndefined();
    act(() => {
      phone.clear();
      phone.deliver([{ ...storm, at: '2026-07-18T06:40:00+02:00', transition: 'power_back' }]);
    });
    expect(result.current.unseen).toBe(1);
  });
});
