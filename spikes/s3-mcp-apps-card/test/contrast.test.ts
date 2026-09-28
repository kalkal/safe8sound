import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, resolveTheme, THEMES } from '../src/tokens/themes.js';

const source = JSON.parse(readFileSync(new URL('../tokens/tokens.json', import.meta.url), 'utf8')) as Record<string, unknown>;

// Text on background: WCAG AA 4.5:1 (plan §11.2 principle 1).
const TEXT_PAIRS: Array<[string, string]> = [
  ['text-primary', 'surface-card'],
  ['text-secondary', 'surface-card'],
  ['text-primary', 'surface-card-raised'],
  ['text-secondary', 'surface-card-raised'],
  ['button-primary-text', 'button-primary-bg'],
  ['button-primary-text', 'button-primary-bg-hover'],
  ['status-ok', 'surface-card'],
  ['status-warn', 'surface-card'],
  ['status-storm', 'surface-card'],
  ['status-alert', 'surface-card'],
  ['status-neutral', 'surface-card'],
  ['level-on', 'level-comfort'],
  ['level-on', 'level-balanced'],
  ['level-on', 'level-saver'],
  ['level-on', 'level-essential'],
];
// Non-text UI (focus ring, accent marks): WCAG 1.4.11, 3:1.
const UI_PAIRS: Array<[string, string]> = [
  ['accent', 'surface-card'],
  ['focus-ring', 'surface-card'],
];

describe('contrast AA for every theme', () => {
  for (const theme of THEMES) {
    const colors = resolveTheme(source, theme);
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${theme.name}: ${fg} on ${bg} >= 4.5`, () => {
        expect(contrastRatio(colors[fg]!, colors[bg]!)).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [fg, bg] of UI_PAIRS) {
      it(`${theme.name}: ${fg} on ${bg} >= 3`, () => {
        expect(contrastRatio(colors[fg]!, colors[bg]!)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe('resolveTheme', () => {
  it('knows the four combinations the card can show', () => {
    expect(THEMES.map((t) => t.name)).toEqual(['pawnio-dark', 'pawnio-light', 'storm-dark', 'storm-light']);
  });

  it('applies the storm override on top of the scheme', () => {
    const dark = resolveTheme(source, { name: 'pawnio-dark', scheme: 'dark', storm: false });
    const storm = resolveTheme(source, { name: 'storm-dark', scheme: 'dark', storm: true });
    expect(storm['accent']).not.toEqual(dark['accent']);
    expect(storm['surface-card']).toEqual(dark['surface-card']);
  });

  it('gives the dark card the Amazon surface #14181E', () => {
    const dark = resolveTheme(source, { name: 'pawnio-dark', scheme: 'dark', storm: false });
    expect(dark['surface-card']).toBe('#14181e');
  });
});
