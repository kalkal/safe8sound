import { formatHex, wcagContrast } from 'culori';

export interface Theme {
  name: string;
  scheme: 'dark' | 'light';
  storm: boolean;
}

export const THEMES: readonly Theme[] = [
  { name: 'pawnio-dark', scheme: 'dark', storm: false },
  { name: 'pawnio-light', scheme: 'light', storm: false },
  { name: 'storm-dark', scheme: 'dark', storm: true },
  { name: 'storm-light', scheme: 'light', storm: true },
];

type Json = Record<string, any>;
type DtcgColor = { colorSpace: string; components: number[]; alpha?: number; hex?: string };

function primitiveHex(source: Json, reference: string): string {
  const match = /^\{p\.([a-z0-9-]+)\}$/.exec(reference);
  if (!match) throw new Error(`Semantic colors must reference a primitive, got ${reference}`);
  const value = source['p']?.[match[1]!]?.$value as DtcgColor | undefined;
  if (!value) throw new Error(`Unknown primitive ${reference}`);
  if (value.hex) return value.hex;
  const [l = 0, c = 0, h = 0] = value.components;
  return formatHex({ mode: 'oklch', l, c, h });
}

/** Resolves every semantic color of one theme to sRGB hex (for contrast checks, not for CSS). */
export function resolveTheme(source: Json, theme: Theme): Record<string, string> {
  const colors: Record<string, string> = {};
  const groups = theme.storm ? [source['color'], source['storm']] : [source['color']];
  for (const group of groups) {
    for (const [name, token] of Object.entries<Json>(group ?? {})) {
      if (name.startsWith('$')) continue;
      const variant = token[theme.scheme];
      if (typeof variant?.$value === 'string') colors[name] = primitiveHex(source, variant.$value);
    }
  }
  return colors;
}

export const contrastRatio = (foreground: string, background: string): number => wcagContrast(foreground, background);
