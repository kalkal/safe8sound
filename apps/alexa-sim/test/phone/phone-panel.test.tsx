// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createScriptedPhone } from '../../src/phone/phone-feed.js';
import { phoneMessage } from '../../src/phone/phone-fixtures.js';
import { PhonePanel } from '../../src/phone/PhonePanel.js';

afterEach(cleanup);

describe('PhonePanel: the family phone, simulated (surface C)', () => {
  it('says it is a simulated phone, and that nothing has arrived yet', () => {
    render(<PhonePanel feed={createScriptedPhone()} timeZone="Europe/Rome" />);
    expect(screen.getByRole('region', { name: "Your daughter's phone (simulated)" })).toBeTruthy();
    expect(screen.getByText('No messages from Cold Reserve yet.')).toBeTruthy();
  });

  it('shows each message as a notification: title in words, home time, and the full text', () => {
    const phone = createScriptedPhone();
    phone.deliver([phoneMessage('storm-started')]);
    render(<PhonePanel feed={phone} timeZone="Europe/Rome" />);
    const note = screen.getByRole('article', { name: 'Power outage (storm) at home' });
    expect(within(note).getByText('Cold Reserve · 19:42')).toBeTruthy();
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
});
