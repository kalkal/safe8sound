// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CardShell } from '../src/CardShell.js';

// Pages instead of scrolling (owner, 10 Oct): a card shows one page at a time, the first with its one giant number;
// "Previous page" / "1 of 3" / "Next page" sit in the card's title row. Every page stays in the card (hidden, not
// removed), so its words are still the card's.

afterEach(cleanup);

const card = () =>
  render(
    <CardShell title="Plan" pages={[<p key="a">07:00</p>, <p key="b">Levels</p>, <p key="c">Battery line</p>]}>
      {null}
    </CardShell>,
  );

describe('CardShell pages', () => {
  it('shows the first page, says where it is, and keeps the others hidden in the card', () => {
    card();
    const nav = screen.getByRole('navigation', { name: 'Pages of this card' });
    expect(nav.textContent).toContain('1 of 3');
    expect(screen.getByText('07:00').closest('[data-page]')?.hasAttribute('hidden')).toBe(false);
    expect(screen.getByText('Levels').closest('[data-page]')?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(true);
  });

  it('Next and Previous move one page and stop at both ends; the short word is in the spoken name', () => {
    card();
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(next.textContent).toBe('Next');
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText('Battery line').closest('[data-page]')?.hasAttribute('hidden')).toBe(false);
    expect(next.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(screen.getByRole('navigation', { name: 'Pages of this card' }).textContent).toContain('2 of 3');
  });

  it('one page, or children only: no page row at all', () => {
    render(<CardShell title="Home">{<p>rooms</p>}</CardShell>);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByText('rooms')).toBeTruthy();
  });
});

describe('CardShell pages: keyboard focus', () => {
  it('when the focused button becomes unavailable at the last or first page, focus moves to the other one', () => {
    card();
    const next = screen.getByRole('button', { name: 'Next page' });
    const previous = screen.getByRole('button', { name: 'Previous page' });
    next.focus();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(document.activeElement).toBe(previous);
    fireEvent.click(previous);
    fireEvent.click(previous);
    expect(document.activeElement).toBe(next);
  });
});
