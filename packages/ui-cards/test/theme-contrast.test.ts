import { readFileSync } from 'node:fs';
import { loadTokenSource } from '@cold-reserve/design-tokens/source';
import { THEMES, contrastRatio, resolveTheme } from '@cold-reserve/design-tokens/themes';
import { describe, expect, it } from 'vitest';
import { cardThemeFor } from '../src/theme.js';
import { textPairs } from './css-pairs.js';

describe('cardThemeFor (hostContext.theme → card theme)', () => {
  it('follows the host, dark by default as in the Amazon card guide', () => {
    expect(cardThemeFor('light')).toBe('pawnio-light');
    expect(cardThemeFor('dark')).toBe('pawnio-dark');
    expect(cardThemeFor(undefined)).toBe('pawnio-dark');
  });
});

describe('textPairs (which text colour sits on which background)', () => {
  it('pairs a rule colour with its own background, or with both card surfaces', () => {
    expect(textPairs('.a { color: var(--text-primary); background: var(--level-comfort); } .b { color: var(--text-secondary); }')).toEqual([
      ['text-primary', 'level-comfort'],
      ['text-secondary', 'surface-card'],
      ['text-secondary', 'surface-card-raised'],
    ]);
  });

  it('pairs a nested block that changes only the background with the colour it inherits', () => {
    const css = '.btn { color: var(--button-primary-text); background: var(--button-primary-bg); &:hover { background: var(--button-primary-bg-hover); } }';
    expect(textPairs(css)).toContainEqual(['button-primary-text', 'button-primary-bg-hover']);
  });

  it('uses the page text colour when no ancestor sets one', () => {
    expect(textPairs('.chip { background: var(--surface-card-raised); }')).toEqual([['text-primary', 'surface-card-raised']]);
  });

  it('skips decorative pseudo-elements without text and non-text properties', () => {
    expect(textPairs('.cube { &::after { background: var(--cube-fill); content: ""; } } .x { border-color: var(--accent); }')).toEqual([]);
  });
});

// Every text colour the card CSS uses, on the background it sits on. WCAG AA 4.5:1 in every theme (plan §11.2 p.1).
const css = readFileSync(new URL('../src/cards.css', import.meta.url), 'utf8');

describe('card text contrast (WCAG AA, every theme)', () => {
  const pairs = textPairs(css);

  it('finds the text colours of the card CSS', () => {
    expect(pairs.length).toBeGreaterThan(5);
  });

  for (const theme of THEMES) {
    const colors = resolveTheme(loadTokenSource(), theme);
    it.each(pairs)(`${theme.name}: %s on %s >= 4.5`, (fg, bg) => {
      expect(contrastRatio(colors[fg] ?? '', colors[bg] ?? '')).toBeGreaterThanOrEqual(4.5);
    });
  }
});
