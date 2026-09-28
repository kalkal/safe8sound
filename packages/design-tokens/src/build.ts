import { err, ok, type Result } from '@cold-reserve/contracts';
import StyleDictionary from 'style-dictionary';
import type { DesignTokens, TransformedToken } from 'style-dictionary/types';
import type { TokenTree } from './source.js';

// Style Dictionary 5.5.5 reads DTCG 2025.10 colors and dimensions, but prints gradients and
// durations as "[object Object]" (spike S3, issue #7): this custom format covers them and
// pairs every semantic color into light-dark().

/** Semantic tokens that the storm theme redefines. */
export const STORM_TOKENS = ['accent', 'cube-fill'] as const;

/** Top-level groups whose tokens come in a dark and a light variant. */
const SCHEMED_GROUPS: readonly string[] = ['color', 'gradient', 'storm'];
const SCHEMES = ['light', 'dark'] as const;
const ANGLE_EXTENSION = 'com.cold-reserve.angle';
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-monospace', 'ui-sans-serif', 'ui-serif']);

export interface TokenBuildError {
  code: 'token_scheme_missing' | 'token_build_failed';
  message: string;
  details?: { token: string };
}

export interface TokenBuild {
  css: string;
  /** Names of the custom properties components may read (without the leading `--`). */
  names: string[];
}

type Json = Record<string, unknown>;
interface DtcgColor {
  colorSpace: string;
  components: number[];
  alpha?: number;
}
interface Stop {
  color: string | DtcgColor;
  position: number;
}
interface Pair {
  group: string;
  name: string;
  type: string | undefined;
  light?: TransformedToken;
  dark?: TransformedToken;
}

const isToken = (key: string) => !key.startsWith('$');
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkSchemes(source: TokenTree): TokenBuildError | undefined {
  for (const group of SCHEMED_GROUPS) {
    const tokens = source[group];
    if (!isObject(tokens)) continue;
    for (const [name, token] of Object.entries(tokens)) {
      if (!isToken(name) || !isObject(token)) continue;
      const missing = SCHEMES.find((scheme) => !isObject(token[scheme]));
      if (missing) {
        return { code: 'token_scheme_missing', message: `Token "${name}" in "${group}" has no ${missing} value.`, details: { token: name } };
      }
    }
  }
  return undefined;
}

function gradientAngles(source: TokenTree): Map<string, number> {
  const angles = new Map<string, number>();
  for (const group of ['gradient', 'storm']) {
    const tokens = source[group];
    if (!isObject(tokens)) continue;
    for (const [name, token] of Object.entries(tokens)) {
      const extensions = isObject(token) ? token['$extensions'] : undefined;
      const angle = isObject(extensions) ? extensions[ANGLE_EXTENSION] : undefined;
      if (typeof angle === 'number') angles.set(`${group}.${name}`, angle);
    }
  }
  return angles;
}

// Same precision as the built-in color/oklch transform, for stops that reach the format untransformed.
function cssColor(color: string | DtcgColor): string {
  if (typeof color === 'string') return color;
  const [l = 0, c = 0, h = 0] = color.components;
  const alpha = color.alpha !== undefined && color.alpha < 1 ? ` / ${String(color.alpha)}` : '';
  return `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(2)}${alpha})`;
}

function fontFamily(value: unknown): string {
  const names = Array.isArray(value) ? value.map(String) : [String(value)];
  return names.map((n) => (GENERIC_FAMILIES.has(n) || !/\s/.test(n) ? n : `"${n}"`)).join(', ');
}

function plainValue(token: TransformedToken): string {
  const value = token.$value as unknown;
  if (token.$type === 'fontFamily') return fontFamily(value);
  if (isObject(value) && 'value' in value && 'unit' in value) return `${String(value['value'])}${String(value['unit'])}`;
  return String(value);
}

function schemedValue(type: string | undefined, light: TransformedToken, dark: TransformedToken, angle: number | undefined): string {
  if (type === 'gradient') {
    const lightStops = light.$value as Stop[];
    const darkStops = dark.$value as Stop[];
    const stops = lightStops.map((stop, i) => {
      const darkStop = darkStops[i] ?? stop;
      return `light-dark(${cssColor(stop.color)}, ${cssColor(darkStop.color)}) ${String(Math.round(stop.position * 100))}%`;
    });
    return `linear-gradient(${String(angle ?? 180)}deg, ${stops.join(', ')})`;
  }
  return `light-dark(${String(light.$value)}, ${String(dark.$value)})`;
}

function formatThemes(tokens: TransformedToken[], angles: Map<string, number>): TokenBuild {
  const root: Array<[string, string]> = [];
  const storm: Array<[string, string]> = [];
  const pairs = new Map<string, Pair>();

  for (const token of tokens) {
    const [group, name, variant] = token.path;
    if (!group || !name || group === 'p') continue;
    if (SCHEMED_GROUPS.includes(group)) {
      const key = `${group}.${name}`;
      const pair = pairs.get(key) ?? { group, name, type: token.$type };
      if (variant === 'light' || variant === 'dark') pair[variant] = token;
      pairs.set(key, pair);
    } else {
      root.push([name, plainValue(token)]);
    }
  }
  for (const [key, pair] of pairs) {
    if (!pair.light || !pair.dark) continue; // checkSchemes already rejected incomplete pairs
    const decl: [string, string] = [pair.name, schemedValue(pair.type, pair.light, pair.dark, angles.get(key))];
    (pair.group === 'storm' ? storm : root).push(decl);
  }

  const decls = (list: Array<[string, string]>) => list.map(([n, v]) => `    --${n}: ${v};`).join('\n');
  const css = [
    '@layer tokens {',
    '  :root {',
    '    color-scheme: dark;',
    decls(root),
    '  }',
    '  :root[data-card-theme="pawnio-dark"] {',
    '    color-scheme: dark;',
    '  }',
    '  :root[data-card-theme="pawnio-light"] {',
    '    color-scheme: light;',
    '  }',
    '  :root.theme-storm {',
    decls(storm),
    '  }',
    '}',
    '',
  ].join('\n');
  const names = [...new Set([...root, ...storm].map(([n]) => n))];
  return { css, names };
}

/** Builds the theme stylesheet from a DTCG token tree with Style Dictionary v5. */
export async function buildTokens(source: TokenTree): Promise<Result<TokenBuild, TokenBuildError>> {
  const schemeError = checkSchemes(source);
  if (schemeError) return err(schemeError);
  const angles = gradientAngles(source);

  let result: TokenBuild | undefined;
  const sd = new StyleDictionary({
    tokens: structuredClone(source) as DesignTokens,
    usesDtcg: true,
    log: { verbosity: 'silent', warnings: 'disabled' },
    hooks: {
      formats: {
        'cold-reserve/themes': ({ dictionary }) => {
          result = formatThemes(dictionary.allTokens, angles);
          return result.css;
        },
      },
    },
    platforms: {
      css: {
        // color/oklch is Style Dictionary's own transform for DTCG 2025.10 color objects.
        transforms: ['color/oklch'],
        files: [{ destination: 'tokens.css', format: 'cold-reserve/themes' }],
      },
    },
  });

  try {
    await sd.formatPlatform('css');
  } catch (e) {
    return err({ code: 'token_build_failed', message: `Style Dictionary could not build the tokens: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (!result) return err({ code: 'token_build_failed', message: 'Style Dictionary produced no output.' });
  return ok(result);
}
