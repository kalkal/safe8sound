// @vitest-environment jsdom
import { homeCalm } from '@cold-reserve/ui-cards';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HomePanel } from '../../src/ui/HomePanel.js';

// "Show my home" (#204): behind a button, so the screen stays clean; keyboard reachable; Escape closes.

afterEach(cleanup);

const frame = () => <p data-testid="home-card">home</p>;

describe('HomePanel', () => {
  it('is closed at first: only the button, which says what it opens', () => {
    render(<HomePanel status={homeCalm()} renderCard={frame} />);
    const button = screen.getByRole('button', { name: 'Show my home' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('home-card')).toBeNull();
  });

  it('opens the home and closes it again with the same button', () => {
    render(<HomePanel status={homeCalm()} renderCard={frame} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    expect(screen.getByRole('button', { name: 'Hide my home' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'My home' }).contains(screen.getByTestId('home-card'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Hide my home' }));
    expect(screen.queryByTestId('home-card')).toBeNull();
  });

  it('Escape closes it and gives the focus back to the button', () => {
    render(<HomePanel status={homeCalm()} renderCard={frame} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    fireEvent.keyDown(screen.getByRole('region', { name: 'My home' }), { key: 'Escape' });
    expect(screen.queryByTestId('home-card')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show my home' }));
  });

  it('without a home to show yet, says how to get it instead of an empty panel', () => {
    render(<HomePanel status={undefined} renderCard={frame} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    expect(screen.getByRole('region', { name: 'My home' }).textContent).toContain('Ask about your rooms or the storm to see your home here.');
  });
});
