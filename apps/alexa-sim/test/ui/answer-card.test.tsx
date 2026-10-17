// @vitest-environment jsdom
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
});
