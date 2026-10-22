// @vitest-environment jsdom
import { StatusFactsSchema } from '@cold-reserve/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AnswerCard } from '../../src/ui/AnswerCard.js';

afterEach(cleanup);

// On a short Echo screen the words of an answer with a card are for screen readers only (the card owns the content
// band). An answer with no card keeps its words on screen: an empty list of cards is no card, never an empty screen.

describe('AnswerCard', () => {
  it('an answer whose list of cards is empty has no card area: its words stay the content', () => {
    render(<AnswerCard answer={{ text: 'Storm mode is prepared.', cards: [] }} timeZone="America/Chicago" turnId="t1" />);
    const answer = screen.getByTestId('answer');
    expect(answer.querySelector('.tool-cards')).toBeNull();
    expect(screen.queryByRole('button', { name: /Read/ })).toBeNull();
    expect(screen.getByText('Storm mode is prepared.')).toBeTruthy();
  });

  it('shows its words as captions, under the test id the specs read', () => {
    render(<AnswerCard answer={{ text: 'Power is back.' }} timeZone="Europe/Rome" turnId="t1" />);
    expect(screen.getByTestId('answer').contains(screen.getByTestId('answer-caption'))).toBe(true);
    expect(screen.getByTestId('answer-caption').textContent).toBe('Power is back.');
  });

  it('an answer given before the clock last moved says so inside the answer, with its simulated time (owner, 18 Oct)', () => {
    render(<AnswerCard answer={{ text: 'The storm reserve is now powering the home.' }} timeZone="Europe/Rome" turnId="t1" earlierAt="15:00" />);
    const when = screen.getByTestId('answer').querySelector('[data-testid="answer-when"]');
    expect(when?.getAttribute('data-earlier')).toBe('true');
    expect(when?.textContent).toBe('Earlier answer · 15:00');
  });

  it('an answer of now has no such label', () => {
    render(<AnswerCard answer={{ text: 'Power is back.' }} timeZone="Europe/Rome" turnId="t1" />);
    expect(screen.queryByTestId('answer-when')).toBeNull();
  });

  it('a question the person answered on the card gets the short confirmation in its place: the big words say "OK, plan applied.", never the question left open (owner, 22 Oct)', () => {
    render(<AnswerCard answer={{ text: 'Do you want me to start this plan?' }} timeZone="Europe/Rome" turnId="t1" applied />);
    expect(screen.getByTestId('answer-caption').textContent).toBe('OK, plan applied.');
    // No small line under it any more: one sentence, the big one.
    expect(screen.queryByTestId('answer-done')).toBeNull();
    expect(screen.queryByText('Do you want me to start this plan?')).toBeNull();
    cleanup();
    render(<AnswerCard answer={{ text: 'Do you want me to start this plan?' }} timeZone="Europe/Rome" turnId="t1" />);
    expect(screen.getByTestId('answer-caption').textContent).toBe('Do you want me to start this plan?');
  });

  // Option B (owner, 20 Oct): the scripted figures are fixed; they say so instead of looking like live readings.
  it('an offline example says so in place of its origin badge, with the time of the scripted clock', () => {
    const status = StatusFactsSchema.parse({ batterySocPct: 78, origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' }, ts: '2026-07-18T12:00:00+02:00' });
    render(<AnswerCard answer={{ text: 'Your battery is at 78 percent.', status, example: true }} timeZone="Europe/Rome" turnId="t1" />);
    expect(screen.getByTestId('offline-example').textContent).toBe('Offline example');
    expect(screen.queryByTestId('origin-badge')).toBeNull();
    expect(screen.getByTestId('answer').textContent).toContain('As of 12:00');
  });

  it('a reading from the real assistant has no such label', () => {
    const status = StatusFactsSchema.parse({ batterySocPct: 78, origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' }, ts: '2026-07-18T12:00:00+02:00' });
    render(<AnswerCard answer={{ text: 'Your battery is at 78 percent.', status }} timeZone="Europe/Rome" turnId="t1" />);
    expect(screen.queryByTestId('offline-example')).toBeNull();
    expect(screen.getByTestId('origin-badge').textContent).toBe('≈ SIMULATED');
  });

  // Review of #479: in remote mode the backup answer's time is the scripted clock's, not the home's: it says none.
  it('a backup answer (the real assistant down) keeps its example label and says no time', () => {
    const status = StatusFactsSchema.parse({ batterySocPct: 78, origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' }, ts: '2026-07-18T12:00:00+02:00' });
    render(<AnswerCard answer={{ text: 'Your battery is at 78 percent.', status, example: true, degradedBy: 'agent_unavailable' }} timeZone="Europe/Rome" turnId="t1" />);
    expect(screen.getByTestId('offline-example').textContent).toBe('Offline example');
    expect(screen.getByTestId('answer').textContent).not.toContain('As of');
  });
});
