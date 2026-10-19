// @vitest-environment jsdom
import type { InboxMessage } from '@cold-reserve/contracts';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhoneOpener, PhonePeek, PhoneSheet, usePhoneSheet } from '../../src/phone/PhoneSheet.js';

// Ana's phone below the side-by-side width (owner, 18 Oct, J = a): an "Ana's phone" button opens it as a modal sheet;
// the button, Escape or a tap outside closes it. Where the phone fits beside the Echo it is always shown, with no
// button. A new message to Ana (owner, 19 Oct, K = b) never blocks the page: a short notice shows under the top bar for
// a few seconds, with "Open Ana's phone".

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PEEK_MS = 8_000;
const message = (at: string): InboxMessage => ({ at, role: 'daughter', channel: 'in_app', transition: 'storm_started', text: 'Power outage at home.' });

function Phone({ beside, messages }: { beside: boolean; messages: readonly InboxMessage[] }) {
  const sheet = usePhoneSheet({ beside, messages, peekMs: PEEK_MS });
  return (
    <>
      <PhoneOpener sheet={sheet} beside={beside} count={messages.length} />
      <PhonePeek sheet={sheet} timeZone="Europe/Rome" />
      <PhoneSheet sheet={sheet} beside={beside}>
        <section aria-label="Your daughter's phone (simulated)">notes</section>
      </PhoneSheet>
      <main>page</main>
    </>
  );
}

const phone = () => screen.queryByRole('region', { name: "Your daughter's phone (simulated)" });
const peek = () => screen.queryByTestId('phone-peek');

describe('PhoneSheet', () => {
  it('beside the Echo: the phone is always shown, no button, and a new message needs no notice', () => {
    const { rerender } = render(<Phone beside messages={[]} />);
    expect(phone()).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Ana's phone/ })).toBeNull();
    rerender(<Phone beside messages={[message('2026-07-17T15:00:00+02:00')]} />);
    expect(peek()).toBeNull();
  });

  it('below it: a button opens the phone as a modal sheet; Escape closes it and the focus goes back', () => {
    render(<Phone beside={false} messages={[]} />);
    expect(phone()).toBeNull();
    const opener = screen.getByRole('button', { name: /Ana's phone/ });
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: "Ana's phone" });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(phone()).not.toBeNull();
    expect(screen.getByRole('main', { hidden: true }).closest('[inert]')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(phone()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a new message shows a notice for a few seconds, never a sheet; the messages already there show none', () => {
    vi.useFakeTimers();
    const first = message('2026-07-17T12:00:00+02:00');
    const { rerender } = render(<Phone beside={false} messages={[first]} />);
    expect(peek()).toBeNull();
    act(() => {
      rerender(<Phone beside={false} messages={[message('2026-07-17T15:00:00+02:00'), first]} />);
    });
    expect(peek()?.textContent).toContain('New message to Ana · 15:00');
    expect(peek()?.textContent).toContain('Power outage (storm) at home');
    // Announced: the notice goes into a live region that was already there.
    expect(peek()?.parentElement?.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('main').closest('[inert]')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(PEEK_MS);
    });
    expect(peek()).toBeNull();
    // A new play of the day empties the phone: fewer messages show nothing.
    act(() => {
      rerender(<Phone beside={false} messages={[]} />);
    });
    expect(peek()).toBeNull();
  });

  it('"Open Ana\'s phone" on the notice opens the sheet and the notice goes', () => {
    const { rerender } = render(<Phone beside={false} messages={[]} />);
    act(() => {
      rerender(<Phone beside={false} messages={[message('2026-07-17T15:00:00+02:00')]} />);
    });
    fireEvent.click(screen.getByRole('button', { name: "Open Ana's phone" }));
    expect(screen.getByRole('dialog', { name: "Ana's phone" })).toBeTruthy();
    expect(peek()).toBeNull();
  });

  it('the button says how many messages Ana has', () => {
    render(<Phone beside={false} messages={[message('2026-07-17T12:00:00+02:00'), message('2026-07-17T15:00:00+02:00')]} />);
    expect(screen.getByRole('button', { name: /Ana's phone/ }).textContent).toContain('2');
  });
});
