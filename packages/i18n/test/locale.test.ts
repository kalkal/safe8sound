import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocale, isLocale, setLocale, subscribeLocale } from '../src/index.js';

// #263: the language the page shows; English by default. One store per page (and one per card frame).

afterEach(() => {
  setLocale('en-US');
});

describe('locale', () => {
  it('is English by default, Italian when chosen, and tells who listens', () => {
    expect(getLocale()).toBe('en-US');
    const listener = vi.fn();
    const stop = subscribeLocale(listener);
    setLocale('it-IT');
    expect(getLocale()).toBe('it-IT');
    expect(listener).toHaveBeenCalledOnce();
    setLocale('it-IT');
    expect(listener).toHaveBeenCalledOnce();
    stop();
  });

  it('knows only its own languages', () => {
    expect(isLocale('it-IT')).toBe(true);
    expect(isLocale('fr-FR')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
