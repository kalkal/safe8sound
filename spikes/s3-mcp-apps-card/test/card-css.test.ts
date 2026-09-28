import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTokens } from '../src/tokens/build.js';

const cardCss = readFileSync(new URL('../src/card/card.css', import.meta.url), 'utf8');
const source = JSON.parse(readFileSync(new URL('../tokens/tokens.json', import.meta.url), 'utf8')) as Record<string, unknown>;

// Container query conditions cannot read custom properties (CSS spec), so the
// breakpoint literal inside an @container prelude is the one allowed exception.
const withoutContainerPreludes = cardCss.replace(/@container[^{]*\{/g, '@container {');
const withoutComments = withoutContainerPreludes.replace(/\/\*[\s\S]*?\*\//g, '');

describe('card.css reads only semantic tokens', () => {
  it('uses only custom properties that the token build defines', async () => {
    const built = await buildTokens(source);
    if (!built.ok) throw new Error(built.error.message);
    // Local component variables (declared in this file, e.g. --level-color) are allowed: their values come from tokens.
    const local = [...withoutComments.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!.slice(2));
    const known = new Set([...built.value.names, ...local, 'cube-part']);
    const used = [...withoutComments.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((name) => !known.has(name))).toEqual([]);
  });

  it('has no hand-written colors', () => {
    expect(withoutComments).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(withoutComments).not.toMatch(/\b(rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/i);
    expect(withoutComments).not.toMatch(/:\s*(white|black)\b/i);
  });

  it('has no hand-written lengths outside container conditions', () => {
    expect(withoutComments).not.toMatch(/\d(px|rem|em)\b/);
  });

  it('never mixes in oklch: white and grays carry hue 0, so an oklch mix drifts toward pink (seen in S3)', () => {
    expect(withoutComments).not.toContain('color-mix(in oklch');
  });

  it('declares the layer order and never uses !important', () => {
    expect(cardCss).toContain('@layer reset, tokens, base, components, surfaces, overrides;');
    expect(cardCss).not.toContain('!important');
  });

  it('uses the modern standards the plan asks for', () => {
    expect(cardCss).toMatch(/container-type:\s*inline-size/);
    expect(cardCss).toMatch(/@container card/);
    expect(cardCss).toMatch(/cqi/);
    expect(cardCss).toContain('color-mix(in oklab');
    expect(cardCss).toContain(':has(');
    expect(cardCss).toMatch(/prefers-reduced-motion/);
    expect(cardCss).toMatch(/margin-inline|padding-inline|inset-inline/);
  });
});
