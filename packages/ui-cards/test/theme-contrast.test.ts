import { readFileSync } from 'node:fs';
import { loadTokenSource } from '@cold-reserve/design-tokens/source';
import { THEMES, contrastRatio, resolveTheme } from '@cold-reserve/design-tokens/themes';
import { describe, expect, it } from 'vitest';
import { cardThemeFor } from '../src/theme.js';

describe('cardThemeFor (hostContext.theme → card theme)', () => {
  it('follows the host, dark by default as in the Amazon card guide', () => {
    expect(cardThemeFor('light')).toBe('pawnio-light');
    expect(cardThemeFor('dark')).toBe('pawnio-dark');
    expect(cardThemeFor(undefined)).toBe('pawnio-dark');
  });
});

// Every text colour the card CSS uses, on the background it sits on: the rule's own background,
// otherwise both card surfaces. WCAG AA 4.5:1 in every theme (plan §11.2 p.1).
const css = readFileSync(new URL('../src/cards.css', import.meta.url), 'utf8');
const CARD_SURFACES = ['surface-card', 'surface-card-raised'];

function textPairs(source: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  // Split on every brace so nested rules (CSS nesting) are read as their own declaration chunks.
  for (const body of source.split(/[{}]/)) {
    const fg = /(?:^|[;\s])color:\s*var\(--([a-z0-9-]+)\)/.exec(body)?.[1];
    if (fg === undefined) continue;
    const bg = /background(?:-color)?:\s*var\(--([a-z0-9-]+)\)/.exec(body)?.[1];
    for (const surface of bg === undefined ? CARD_SURFACES : [bg]) pairs.push([fg, surface]);
  }
  return pairs;
}

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
