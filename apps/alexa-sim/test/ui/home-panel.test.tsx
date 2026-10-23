// @vitest-environment jsdom
import { homeCalm } from '@cold-reserve/ui-cards';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHomePanel, type HomePanelProps } from '../../src/ui/HomePanel.js';

// "Show my home" (#204): behind a button, so the screen stays clean; keyboard reachable; Escape closes.

afterEach(cleanup);

const frame = () => <p data-testid="home-card">home</p>;

/** Three bands (owner, 10 Oct): the button sits in the header band, the home in the content band. */
function HomePanel(props: HomePanelProps) {
  const { button, view } = useHomePanel(props);
  return (
    <>
      <header data-testid="head">{button}</header>
      <div data-testid="content">{view}</div>
    </>
  );
}

describe('HomePanel', () => {
  it('before the demo code: a plain note to enter it, no failure, no read and no stale card (owner, 18 Oct)', () => {
    const onOpen = vi.fn();
    render(<HomePanel status={homeCalm()} renderCard={frame} load="locked" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    expect(screen.getByRole('region', { name: 'My home' }).textContent).toBe('My homeEnter the demo code to see your home.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('home-card')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  // The day's turns used up (review of #482): the home says the same words as the screen, reads nothing, offers no Retry.
  it('the demo full for today: the same words as the screen, no read, no failure, no Retry, no stale card', () => {
    const onOpen = vi.fn();
    render(<HomePanel status={homeCalm()} renderCard={frame} load="failed" onOpen={onOpen} closedNotice="The demo limit for today is reached. Back at 02:00 (your time)." />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    expect(screen.getByRole('region', { name: 'My home' }).textContent).toBe('My homeThe demo limit for today is reached. Back at 02:00 (your time).');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByTestId('home-card')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

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

  it('three bands: the button stays in the header, the home opens in the content band', () => {
    render(<HomePanel status={homeCalm()} renderCard={frame} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    expect(screen.getByTestId('head').contains(screen.getByRole('button', { name: 'Hide my home' }))).toBe(true);
    expect(screen.getByTestId('content').contains(screen.getByRole('region', { name: 'My home' }))).toBe(true);
  });

  it('said aloud (idea 4): open() does what the button does, and reads the home once', () => {
    const onOpen = vi.fn();
    function Said() {
      const { button, view, open } = useHomePanel({ status: homeCalm(), renderCard: frame, onOpen });
      return (
        <>
          {button}
          <button type="button" onClick={open}>
            say show
          </button>
          {view}
        </>
      );
    }
    render(<Said />);
    fireEvent.click(screen.getByRole('button', { name: 'say show' }));
    expect(screen.getByRole('button', { name: 'Hide my home' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('home-card')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'say show' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // #432 S5: one page of the screen at a time; opening the home closes the settings, before the demo code too.
  it('onShow runs at each opening, tapped or said, even before the demo code (no read then)', () => {
    const onShow = vi.fn();
    const onOpen = vi.fn();
    render(<HomePanel status={homeCalm()} renderCard={frame} load="locked" onOpen={onOpen} onShow={onShow} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide my home' }));
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('Escape closes it and gives the focus back to the button', () => {
    render(<HomePanel status={homeCalm()} renderCard={frame} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    fireEvent.keyDown(screen.getByRole('region', { name: 'My home' }), { key: 'Escape' });
    expect(screen.queryByTestId('home-card')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show my home' }));
  });

  // #432 S6: the button lives in the screen's menu, which is closed while the home shows; the focus then goes where
  // the caller says (the menu button), never lost on the page.
  it('Escape gives the focus to the fallback when the button is not on the page (a closed menu)', () => {
    const fallback = vi.fn();
    function InMenu() {
      const { button, view, open } = useHomePanel({ status: homeCalm(), renderCard: frame, onFocusLost: fallback });
      return (
        <>
          <button type="button" onClick={open}>
            open
          </button>
          {view === null && button}
          {view}
        </>
      );
    }
    render(<InMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.keyDown(screen.getByRole('region', { name: 'My home' }), { key: 'Escape' });
    expect(screen.queryByTestId('home-card')).toBeNull();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('without a home to show yet, says how to get it instead of an empty panel', () => {
    render(<HomePanel status={undefined} renderCard={frame} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    expect(screen.getByRole('region', { name: 'My home' }).textContent).toContain('Ask about your rooms or the storm to see your home here.');
  });

  it('#262: opening it asks for the home; while it comes, says so', () => {
    const onOpen = vi.fn();
    render(<HomePanel status={undefined} renderCard={frame} load="loading" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.getByRole('region', { name: 'My home' }).textContent).toContain('Getting your home…');
  });

  it('#262: when the home cannot be reached, says it honestly and offers to try again', () => {
    const onRetry = vi.fn();
    render(<HomePanel status={undefined} renderCard={frame} load="failed" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my home' }));
    expect(screen.getByRole('region', { name: 'My home' }).textContent).toContain("I can't reach your home right now. Try again in a moment.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
