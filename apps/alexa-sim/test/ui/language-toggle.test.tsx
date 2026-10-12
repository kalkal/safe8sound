// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '@cold-reserve/i18n';
import { LanguageToggle, nextLocale } from '../../src/ui/LanguageToggle.js';

// The language icon at the top (owner, 10 Oct): one quiet button that offers the other language, named in that
// language, so its name is what it does and what to say. English by default.

afterEach(() => {
  cleanup();
  setLocale('en-US');
});

describe('LanguageToggle', () => {
  it('in English it offers Italiano, says it is the language choice, and switches when tapped', () => {
    const onLocale = vi.fn();
    render(<LanguageToggle locale="en-US" onLocale={onLocale} />);
    const button = screen.getByRole('button', { name: 'Language: Italiano' });
    expect(button.querySelector('[lang]')?.getAttribute('lang')).toBe('it');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(button);
    expect(onLocale).toHaveBeenCalledWith('it-IT');
  });

  it('in Italian it offers English back', () => {
    setLocale('it-IT');
    const onLocale = vi.fn();
    render(<LanguageToggle locale="it-IT" onLocale={onLocale} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lingua: English' }));
    expect(onLocale).toHaveBeenCalledWith('en-US');
  });

  it('with Italian chosen, one quiet line says the answers are still in English, and describes the button', () => {
    setLocale('it-IT');
    render(<LanguageToggle locale="it-IT" onLocale={vi.fn()} />);
    const note = screen.getByTestId('language-top-note');
    expect(note.textContent).toBe('Alexa risponde ancora in inglese.');
    expect(screen.getByRole('button', { name: 'Lingua: English' }).getAttribute('aria-describedby')).toBe(note.id);
  });

  it('in English there is no such line', () => {
    render(<LanguageToggle locale="en-US" onLocale={vi.fn()} />);
    expect(screen.queryByTestId('language-top-note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Language: Italiano' }).hasAttribute('aria-describedby')).toBe(false);
  });

  it('the next language goes round the shipped ones', () => {
    expect(nextLocale('en-US')).toBe('it-IT');
    expect(nextLocale('it-IT')).toBe('en-US');
  });
});
