import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Storm stays calm (plan §11.2 p.13, issue #24): with prefers-reduced-motion nothing in a card moves,
// and any motion a card adds goes through the duration tokens that the media query sets to zero.

const css = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

/** The body of `@media (prefers-reduced-motion: reduce) { ... }`, braces balanced. */
function reducedMotionBlock(source: string): string | undefined {
  const start = source.indexOf('@media (prefers-reduced-motion: reduce)');
  if (start < 0) return undefined;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  return undefined;
}

describe('reduced motion', () => {
  it('cards.css (in every card document) stops every transition and animation, and zeroes the duration token', () => {
    const block = reducedMotionBlock(css('cards.css'));
    expect(block).toBeDefined();
    expect(block).toMatch(/--duration-fast:\s*0ms/);
    expect(block).toMatch(/transition-duration:\s*0ms/);
    expect(block).toMatch(/animation-duration:\s*0ms/);
    expect(block).toMatch(/animation-iteration-count:\s*1/);
    expect(block).toMatch(/\*::before/);
  });

  it('lives in the overrides layer, so no component rule can bring motion back', () => {
    const source = css('cards.css');
    const overrides = source.indexOf('@layer overrides {');
    expect(overrides).toBeGreaterThan(-1);
    expect(source.indexOf('@media (prefers-reduced-motion: reduce)')).toBeGreaterThan(overrides);
  });

  it.each(['cards.css', 'cubes.css'])('no rule in %s hard-codes a duration: motion uses the tokens', (file) => {
    const source = css(file);
    const motionRule = reducedMotionBlock(source) ?? '';
    const declarations = [...source.replace(motionRule, '').matchAll(/(transition|animation)[\w-]*\s*:\s*([^;]+);/g)];
    for (const [, , value] of declarations) expect(value).not.toMatch(/\d+m?s\b/);
  });

  it('the melting cube (cubes.css, shared with the idle screen) moves only through the melt duration token, so reduced motion shows it already melted', () => {
    const source = css('cubes.css');
    expect(source).toMatch(/\.cube\[data-melting="true"\]::after\s*\{[^}]*animation:[^;]*var\(--duration-melt\)[^;]*forwards;/);
  });
});
