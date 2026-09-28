import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTokens, STORM_TOKENS } from '../src/tokens/build.js';

const source = JSON.parse(readFileSync(new URL('../tokens/tokens.json', import.meta.url), 'utf8')) as Record<string, unknown>;

async function css(): Promise<string> {
  const result = await buildTokens(source);
  if (!result.ok) throw new Error(`build failed: ${result.error.code} ${result.error.message}`);
  return result.value.css;
}

function block(text: string, selector: string): string {
  const start = text.indexOf(`${selector} {`);
  expect(start, `missing block ${selector}`).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf('}', start));
}

describe('buildTokens (Style Dictionary v5, DTCG 2025.10)', () => {
  it('wraps every generated rule in the tokens cascade layer', async () => {
    const out = await css();
    expect(out.trimStart().startsWith('@layer tokens {')).toBe(true);
    expect(out.match(/@layer/g)).toHaveLength(1);
  });

  it('emits every semantic color as light-dark(light, dark) in oklch', async () => {
    const root = block(await css(), ':root');
    expect(root).toContain('--surface-card: light-dark(oklch(1.0000 0.0000 0.00), oklch(0.2076 0.0135 258.37));');
    expect(root).toMatch(/--text-primary: light-dark\(oklch\([^)]*\), oklch\([^)]*\)\);/);
    expect(root).toMatch(/--surface-card-line: light-dark\(oklch\([^)]*\/ 0\.16\), oklch\([^)]*\/ 0\.15\)\);/);
  });

  it('defaults the card to the dark scheme and maps the two pawnio themes to color-scheme', async () => {
    const out = await css();
    expect(block(out, ':root')).toContain('color-scheme: dark;');
    expect(block(out, ':root[data-card-theme="pawnio-dark"]')).toContain('color-scheme: dark;');
    expect(block(out, ':root[data-card-theme="pawnio-light"]')).toContain('color-scheme: light;');
  });

  it('turns DTCG gradients into linear-gradient with light-dark() color stops and the angle extension', async () => {
    const root = block(await css(), ':root');
    expect(root).toMatch(
      /--cube-fill: linear-gradient\(145deg, light-dark\(oklch\([^)]*\), oklch\([^)]*\)\) 0%, light-dark\(oklch\([^)]*\), oklch\([^)]*\)\) 35%, light-dark\([^)]*\), oklch\([^)]*\)\) 100%\);/,
    );
  });

  it('lets the storm theme redefine only its own tokens', async () => {
    const storm = block(await css(), ':root.theme-storm');
    const names = [...storm.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...STORM_TOKENS].sort());
    expect(storm).toMatch(/--accent: light-dark\(oklch\([^)]*\), oklch\([^)]*\)\);/);
  });

  it('emits dimensions, durations, font families and weights as plain CSS values', async () => {
    const root = block(await css(), ':root');
    expect(root).toContain('--radius-card: 16px;');
    expect(root).toContain('--target-min: 48px;');
    expect(root).toContain('--duration-fast: 150ms;');
    expect(root).toContain('--font-body: Roboto, system-ui, sans-serif;');
    expect(root).toContain('--font-data: "Roboto Mono", ui-monospace, monospace;');
    expect(root).toContain('--font-weight-bold: 700;');
  });

  it('never exposes primitives to components', async () => {
    expect(await css()).not.toContain('--p-');
  });

  it('returns the list of semantic token names for the typed module', async () => {
    const result = await buildTokens(source);
    expect(result.ok && result.value.names).toEqual(expect.arrayContaining(['surface-card', 'cube-fill', 'radius-card', 'font-body']));
    expect(result.ok && result.value.names.some((n) => n.startsWith('p-'))).toBe(false);
  });

  it('fails with token_scheme_missing when a semantic color lacks its light value', async () => {
    const broken = structuredClone(source) as { color: Record<string, Record<string, unknown>> };
    delete broken.color['text-primary']!['light'];
    const result = await buildTokens(broken);
    expect(result).toMatchObject({ ok: false, error: { code: 'token_scheme_missing', details: { token: 'text-primary' } } });
  });

  it('fails with token_build_failed on a broken reference instead of throwing', async () => {
    const broken = structuredClone(source) as { color: { accent: { dark: { $value: string } } } };
    broken.color.accent.dark.$value = '{p.nope}';
    const result = await buildTokens(broken);
    expect(result).toMatchObject({ ok: false, error: { code: 'token_build_failed' } });
  });
});
