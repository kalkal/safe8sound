// @vitest-environment jsdom
import { err, ok, toolError } from '@cold-reserve/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DemoSession } from '../src/agent/demo-session.js';
import { DemoCodeGate } from '../src/ui/DemoCodeGate.js';

afterEach(cleanup);

const CODE = 'judges-demo-code-2026';

function fakeSession(start: DemoSession['start'], expired = false, refused = expired): DemoSession {
  return { token: () => undefined, expired: () => expired, refused: () => refused, start, invalidate: vi.fn(), subscribe: () => () => undefined };
}

const field = () => screen.getByLabelText<HTMLInputElement>('Demo code');

describe('DemoCodeGate: the demo code field (remote mode, no token)', () => {
  it('hides the code by default, never autocompletes it, and can show it', () => {
    render(<DemoCodeGate session={fakeSession(vi.fn())} />);
    expect(field().type).toBe('password');
    expect(field().autocomplete).toBe('off');
    expect(field().className).toContain('demo-code');
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    expect(field().type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide code' }));
    expect(field().type).toBe('password');
  });

  it('stops at 128 characters and sends a pasted code without the spaces or line break around it (injection hardening)', async () => {
    const start = vi.fn(() => Promise.resolve(ok(undefined)));
    render(<DemoCodeGate session={fakeSession(start)} />);
    expect(field().maxLength).toBe(128);
    fireEvent.change(field(), { target: { value: `  ${CODE}\n` } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(start).toHaveBeenCalledWith(CODE);
    await waitFor(() => {
      expect(field().value).toBe('');
    });
  });

  it('says at once that a code with a space inside or too short is not valid, without asking the server (security review)', () => {
    const start = vi.fn(() => Promise.resolve(ok(undefined)));
    render(<DemoCodeGate session={fakeSession(start)} />);
    for (const typed of ['judges demo code 2026', 'tooshort']) {
      fireEvent.change(field(), { target: { value: typed } });
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    }
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe("That demo code doesn't work. Check it and try again.");
  });

  it('says, before the code is entered, that the access logs keep the IP address for 30 days (#244)', () => {
    render(<DemoCodeGate session={fakeSession(vi.fn())} />);
    expect(screen.getByText('This demo keeps your IP address in its access logs for 30 days, for security.')).toBeTruthy();
  });

  it('exchanges the code and empties the field right after', async () => {
    const start = vi.fn(() => Promise.resolve(ok(undefined)));
    render(<DemoCodeGate session={fakeSession(start)} />);
    fireEvent.change(field(), { target: { value: CODE } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(start).toHaveBeenCalledWith(CODE);
    await waitFor(() => {
      expect(field().value).toBe('');
    });
  });

  it('says a wrong code is not valid, and empties the field too', async () => {
    render(<DemoCodeGate session={fakeSession(() => Promise.resolve(err(toolError('invalid_demo_code', 'No.'))))} />);
    fireEvent.change(field(), { target: { value: CODE } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect((await screen.findByRole('alert')).textContent).toBe("That demo code doesn't work. Check it and try again.");
    expect(field().value).toBe('');
  });

  it('says the session expired when sim-api refused an old token', () => {
    render(<DemoCodeGate session={fakeSession(vi.fn(), true)} />);
    expect(screen.getByRole('status').textContent).toBe('Session expired: enter the demo code again.');
  });

  it('keeps one live region on the page, empty until there is something to say (review of #140)', () => {
    render(<DemoCodeGate session={fakeSession(vi.fn())} />);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('asks for the code again when the token was refused for another reason than expiry', () => {
    render(<DemoCodeGate session={fakeSession(vi.fn(), false, true)} />);
    expect(screen.getByRole('status').textContent).toBe('Enter the demo code again to continue.');
  });

  it('says plainly when the demo is switched off', async () => {
    render(<DemoCodeGate session={fakeSession(() => Promise.resolve(err(toolError('demo_disabled', 'Off.'))))} />);
    fireEvent.change(field(), { target: { value: CODE } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The demo is switched off for now.');
  });

  it('keeps Start focusable while the code is checked: aria-disabled, never disabled', () => {
    render(<DemoCodeGate session={fakeSession(() => new Promise(() => undefined))} />);
    const start = screen.getByRole('button', { name: 'Start' });
    fireEvent.change(field(), { target: { value: CODE } });
    start.focus();
    fireEvent.click(start);
    expect((start as HTMLButtonElement).disabled).toBe(false);
    expect(start.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(start);
  });
});
