import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLocale, saveLocale } from '../../src/ui/locale-setting.js';

// #263: the chosen language is a page setting kept in the browser; storage may be missing or throw (private window,
// blocked site data): the page then simply starts in English.

afterEach(() => {
  vi.unstubAllGlobals();
});

const storage = (data: Record<string, string> = {}) => ({
  getItem: (k: string) => data[k] ?? null,
  setItem: (k: string, v: string) => {
    data[k] = v;
  },
});

describe('locale setting', () => {
  it('reads the saved language, English when none or an unknown one is saved', () => {
    vi.stubGlobal('localStorage', storage({ 'cold-reserve.locale': 'it-IT' }));
    expect(readLocale()).toBe('it-IT');
    vi.stubGlobal('localStorage', storage({ 'cold-reserve.locale': 'fr-FR' }));
    expect(readLocale()).toBe('en-US');
    vi.stubGlobal('localStorage', storage());
    expect(readLocale()).toBe('en-US');
  });

  it('a storage that throws never breaks the page', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readLocale()).toBe('en-US');
    expect(() => {
      saveLocale('it-IT');
    }).not.toThrow();
  });

  it('saves the choice', () => {
    const data: Record<string, string> = {};
    vi.stubGlobal('localStorage', storage(data));
    saveLocale('it-IT');
    expect(data['cold-reserve.locale']).toBe('it-IT');
  });
});
