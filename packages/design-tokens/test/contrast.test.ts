import { describe, expect, it } from 'vitest';
import { loadTokenSource } from '../src/source.js';
import { THEMES, contrastRatio, gradientStops, over, resolveTheme, resolveThemeRgba } from '../src/themes.js';

const source = loadTokenSource();

// Text on its background: WCAG AA 4.5:1 (plan §11.2 principle 1).
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
  // The guard receipt is paper in both themes (design analysis G4): its ink, its PASS and FAIL, on the paper.
  ['receipt-ink', 'receipt-paper'],
  ['receipt-ink-2', 'receipt-paper'],
  ['receipt-pass', 'receipt-paper'],
  ['receipt-fail', 'receipt-paper'],
];
// Non-text UI (focus ring, accent marks): WCAG 1.4.11, 3:1.
const UI_PAIRS: Array<[string, string]> = [
  ['accent', 'surface-card'],
  ['focus-ring', 'surface-card'],
];

describe('AA contrast for every theme', () => {
  for (const theme of THEMES) {
    const colors = resolveTheme(source, theme);
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${theme.name}: ${fg} on ${bg} >= 4.5`, () => {
        expect(contrastRatio(colors[fg] ?? '', colors[bg] ?? '')).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [fg, bg] of UI_PAIRS) {
      it(`${theme.name}: ${fg} on ${bg} >= 3`, () => {
        expect(contrastRatio(colors[fg] ?? '', colors[bg] ?? '')).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

// Text over the sky of the Echo Show (#432 S3): the sky is drawn edge to edge, so words never sit on it bare. They
// sit on a translucent tile or on the dimmed scrim of an answer, and the colour the eye sees is the tile composited
// over whatever part of the sky is behind it: every stop of every sky, alone and under any of the sun, glow or clouds
// (all of them on every sky, so a layer the Echo layout adds later is covered too).
const SKIES = ['sky-mild', 'sky-hot', 'sky-dusk', 'sky-storm'];
const OVERLAYS = ['sky-sun', 'sky-glow', 'sky-cloud'];

describe('AA contrast for text over the sky', () => {
  for (const theme of THEMES) {
    const colors = resolveThemeRgba(source, theme);
    for (const sky of SKIES) {
      const stops = gradientStops(source, theme, sky);
      const layers = OVERLAYS.map((name) => colors[name]).filter((c) => c !== undefined);
      const behind = [
        ...stops,
        ...stops.flatMap((stop) => layers.map((layer) => over(layer, stop))),
        ...stops.map((stop) => layers.reduce((under, layer) => over(layer, under), stop)),
      ];
      for (const surface of ['surface-tile', 'surface-scrim']) {
        it(`${theme.name}: text-on-sky on ${surface} over ${sky} >= 4.5`, () => {
          const veil = colors[surface];
          const text = colors['text-on-sky'];
          if (veil === undefined || text === undefined) throw new Error(`missing ${surface} or text-on-sky`);
          expect(layers, sky).toHaveLength(OVERLAYS.length);
          const worst = Math.min(...behind.map((under) => contrastRatio(text.hex, over(veil, under))));
          expect(worst).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  it('composites a translucent colour over an opaque one in sRGB, as the browser paints it', () => {
    expect(over({ hex: '#000000', alpha: 0.5 }, '#ffffff')).toBe('#808080');
    expect(over({ hex: '#ff0000', alpha: 1 }, '#00ff00')).toBe('#ff0000');
    expect(over({ hex: '#ff0000', alpha: 0 }, '#00ff00')).toBe('#00ff00');
  });

  it('reads the alpha of a translucent primitive and the stops of a gradient', () => {
    const dark = THEMES[0];
    if (dark === undefined) throw new Error('no theme');
    expect(resolveThemeRgba(source, dark)['sky-veil']).toEqual({ hex: '#040e30', alpha: 0.55 });
    expect(resolveThemeRgba(source, dark)['text-primary']?.alpha).toBe(1);
    expect(gradientStops(source, dark, 'sky-mild')).toEqual(['#0941da', '#00a3a3', '#3ddc97']);
    expect(() => gradientStops(source, dark, 'sky-nowhere')).toThrow();
    // A translucent stop cannot be composited as an opaque colour: refused, never read as opaque.
    const translucent = structuredClone(source) as Record<string, Record<string, { dark: { $value: { color: string }[] } }>>;
    const stop = translucent['gradient']?.['sky-mild']?.dark.$value[0];
    if (stop === undefined) throw new Error('fixture');
    stop.color = '{p.sky-navy-950-a60}';
    expect(() => gradientStops(translucent, dark, 'sky-mild')).toThrow(/translucent/);
  });
});

describe('resolveTheme', () => {
  it('knows the pawnio themes and the storm theme over both schemes', () => {
    expect(THEMES.map((t) => t.name)).toEqual(['pawnio-dark', 'pawnio-light', 'storm-dark', 'storm-light']);
  });

  it('applies the storm override on top of the scheme', () => {
    const dark = resolveTheme(source, { name: 'pawnio-dark', scheme: 'dark', storm: false });
    const storm = resolveTheme(source, { name: 'storm-dark', scheme: 'dark', storm: true });
    expect(storm['accent']).not.toEqual(dark['accent']);
    expect(storm['surface-card']).toEqual(dark['surface-card']);
  });

  it('gives the dark card the Amazon surface #14181E and the primary button #007F80', () => {
    const dark = resolveTheme(source, { name: 'pawnio-dark', scheme: 'dark', storm: false });
    expect(dark['surface-card']).toBe('#14181e');
    expect(dark['button-primary-bg']).toBe('#007f80');
  });

  it('fails loudly on an unresolvable color instead of skipping the pair', () => {
    expect(() => contrastRatio('', '#ffffff')).toThrow();
  });
});
