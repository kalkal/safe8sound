import { describe, expect, it } from 'vitest';
import { STORM_TOKENS, buildTokens } from '../src/build.js';
import { loadTokenSource } from '../src/source.js';

const source = loadTokenSource();

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

describe('buildTokens (Style Dictionary 5, DTCG 2025.10)', () => {
  it('wraps every generated rule in the tokens cascade layer', async () => {
    const out = await css();
    expect(out.trimStart().startsWith('@layer tokens {')).toBe(true);
    expect(out.match(/@layer/g)).toHaveLength(1);
  });

  it('emits every semantic color as light-dark(light, dark) in oklch', async () => {
    const root = block(await css(), ':root');
    expect(root).toContain('--surface-card: light-dark(oklch(1.0000 0.0000 0.00), oklch(0.2076 0.0135 258.37));');
    expect(root).toMatch(/--text-primary: light-dark\(oklch\([^)]*\), oklch\([^)]*\)\);/);
  });

  it('defaults to the dark scheme and maps the pawnio themes to color-scheme', async () => {
    const out = await css();
    expect(block(out, ':root')).toContain('color-scheme: dark;');
    expect(block(out, ':root[data-card-theme="pawnio-dark"]')).toContain('color-scheme: dark;');
    expect(block(out, ':root[data-card-theme="pawnio-light"]')).toContain('color-scheme: light;');
  });

  it('turns DTCG gradients into linear-gradient with light-dark() stops and the angle extension', async () => {
    const root = block(await css(), ':root');
    expect(root).toMatch(/--cube-fill: linear-gradient\(145deg, light-dark\(oklch\([^)]*\), oklch\([^)]*\)\) 0%, /);
  });

  it('gives the Echo Show frame four skies, a sun, clouds, a veil and the bezel, the same in both schemes (the frame never changes theme)', async () => {
    const root = block(await css(), ':root');
    for (const sky of ['sky-mild', 'sky-hot', 'sky-dusk', 'sky-storm']) {
      const line = root.split('\n').find((l) => l.includes(`--${sky}: linear-gradient(135deg, `)) ?? '';
      const stops = [...line.matchAll(/light-dark\((oklch\([^)]*\)), (oklch\([^)]*\))\)/g)];
      expect(stops.length, sky).toBe(3);
      for (const [, light, dark] of stops) expect(light, sky).toBe(dark);
    }
    for (const name of ['sky-veil', 'sky-sun', 'sky-glow', 'sky-cloud', 'frame-bezel']) {
      const line = root.split('\n').find((l) => l.includes(`--${name}: `)) ?? '';
      const [, light, dark] = /light-dark\((oklch\([^)]*\)), (oklch\([^)]*\))\);/.exec(line) ?? [];
      expect(light, name).toBeDefined();
      expect(light, name).toBe(dark);
    }
  });

  it('draws the ice cubes at 56 px and lets one melt in a second and a half (owner decision, 2 Oct)', async () => {
    const root = block(await css(), ':root');
    expect(root).toContain('--cube-size: 56px;');
    expect(root).toContain('--duration-melt: 1500ms;');
  });

  it('lets the storm theme redefine only its own tokens', async () => {
    const storm = block(await css(), ':root.theme-storm');
    const names = [...storm.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...STORM_TOKENS].sort());
  });

  it('emits dimensions, durations, font families and weights as plain CSS values', async () => {
    const root = block(await css(), ':root');
    expect(root).toContain('--radius-card: 16px;');
    expect(root).toContain('--duration-fast: 150ms;');
    expect(root).toContain('--font-body: Roboto, system-ui, sans-serif;');
    expect(root).toContain('--font-data: "Roboto Mono", ui-monospace, monospace;');
    expect(root).toContain('--font-weight-bold: 700;');
  });

  it('never exposes primitives to components', async () => {
    const result = await buildTokens(source);
    expect(result.ok && result.value.css).not.toContain('--p-');
    expect(result.ok && result.value.names.some((n) => n.startsWith('p-'))).toBe(false);
  });

  it('fails with token_scheme_missing when a semantic color lacks one scheme', async () => {
    const broken = structuredClone(source) as { color: Record<string, Record<string, unknown>> };
    delete broken.color['text-primary']?.['light'];
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
