// @vitest-environment jsdom
import type { SafeRoomStatus } from '@cold-reserve/contracts';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createScriptedPhone, type PhoneFeed } from '../../src/phone/phone-feed.js';
import { phoneMessage } from '../../src/phone/phone-fixtures.js';
import { PhonePanel } from '../../src/phone/PhonePanel.js';

afterEach(cleanup);

describe('PhonePanel: the family phone, simulated (surface C)', () => {
  it('says it is a simulated phone, and that nothing has arrived yet', () => {
    render(<PhonePanel feed={createScriptedPhone()} timeZone="Europe/Rome" />);
    expect(screen.getByRole('region', { name: "Your daughter's phone (simulated)" })).toBeTruthy();
    expect(screen.getByText('No messages from Safe-8-Sound yet.')).toBeTruthy();
  });

  it('owner feedback (6 Oct): Ana\'s phone is a connected device with its own icon, a drawing beside the title', () => {
    const { container } = render(<PhonePanel feed={createScriptedPhone()} timeZone="Europe/Rome" />);
    const icon = container.querySelector('h2 svg[data-device="phone"]');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    // The title stays the accessible name: the icon adds nothing to it.
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe("Your daughter's phone (simulated)");
  });

  it('shows each message as a notification: title in words, home time, and the full text', () => {
    const phone = createScriptedPhone();
    phone.deliver([phoneMessage('storm-started')]);
    render(<PhonePanel feed={phone} timeZone="Europe/Rome" />);
    const note = screen.getByRole('article', { name: 'Power outage (storm) at home' });
    expect(within(note).getByText('Safe-8-Sound · 19:42')).toBeTruthy();
    expect(note.textContent).toContain('keeps it safe until');
  });

  it('adds new messages on top as they arrive, politely announced', () => {
    const phone = createScriptedPhone();
    render(<PhonePanel feed={phone} timeZone="Europe/Rome" />);
    act(() => {
      phone.deliver([phoneMessage('storm-started')]);
    });
    act(() => {
      phone.deliver([phoneMessage('essential'), phoneMessage('power-back')]);
    });
    const list = screen.getByRole('list', { name: 'Notifications' });
    expect(list.getAttribute('aria-live')).toBe('polite');
    expect(within(list).getAllByRole('heading').map((h) => h.textContent)).toEqual(['Power is back at home', 'Switched to Essential', 'Power outage (storm) at home']);
  });

  describe('replies (queue item 3, #24)', () => {
    const withReply = (reply: NonNullable<PhoneFeed['reply']>) => {
      const phone = createScriptedPhone();
      phone.deliver([phoneMessage('storm-started')]);
      return { ...phone, reply };
    };

    it('offers no reply before a message arrives', () => {
      render(<PhonePanel feed={{ ...createScriptedPhone(), reply: () => Promise.resolve({ ok: true }) }} timeZone="Europe/Rome" />);
      expect(screen.queryByRole('button', { name: "I'm on my way" })).toBeNull();
    });

    it('"I\'m on my way": one tap, one call, then says it was sent', async () => {
      const calls: string[] = [];
      render(<PhonePanel feed={withReply((r) => (calls.push(r), Promise.resolve({ ok: true })))} timeZone="Europe/Rome" />);
      const button = screen.getByRole('button', { name: "I'm on my way" });
      await act(async () => {
        fireEvent.click(button);
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(calls).toEqual(['on_my_way']);
      expect(screen.getByRole('status').textContent).toBe("Sent: they know you're on your way.");
    });

    it('says "Sending…" while the request runs (#196 review)', async () => {
      let answer: (r: { ok: true }) => void = () => undefined;
      render(<PhonePanel feed={withReply(() => new Promise((resolve) => (answer = resolve)))} timeZone="Europe/Rome" />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: "I'm on my way" }));
        await Promise.resolve();
      });
      expect(screen.getByRole('status').textContent).toBe('Sending…');
      await act(async () => {
        answer({ ok: true });
        await Promise.resolve();
      });
      expect(screen.getByRole('status').textContent).toBe("Sent: they know you're on your way.");
    });

    it('"Check status" shows the safe room in home time, the same time the voice says', async () => {
      const status = { safeRoomId: 'bedroom-1', tempC: 25.5, safeUntil: '2026-07-18T01:20:00+02:00' } as unknown as SafeRoomStatus;
      render(<PhonePanel feed={withReply(() => Promise.resolve({ ok: true, status }))} timeZone="Europe/Rome" />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
        await Promise.resolve();
      });
      expect(screen.getByRole('status').textContent).toBe('Safe room at 25.5 °C, safe until 01:20.');
    });

    it('too soon or failed: says so in words, never a code', async () => {
      const { unmount } = render(<PhonePanel feed={withReply(() => Promise.resolve({ ok: false, code: 'family_reply_rate_limited', retryAfterMs: 19_200 }))} timeZone="Europe/Rome" />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
        await Promise.resolve();
      });
      expect(screen.getByRole('status').textContent).toBe('Just sent: try again in 20 s.');
      unmount();
      render(<PhonePanel feed={withReply(() => Promise.resolve({ ok: false, code: 'phone_reply_unreachable' }))} timeZone="Europe/Rome" />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: "I'm on my way" }));
        await Promise.resolve();
      });
      expect(screen.getByRole('status').textContent).toBe('Not sent: try again.');
    });
  });
});
