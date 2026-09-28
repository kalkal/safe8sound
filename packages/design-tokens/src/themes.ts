import { formatHex, parse, wcagContrast } from 'culori';
import type { TokenTree } from './source.js';

export interface Theme {
  name: string;
  scheme: 'dark' | 'light';
  storm: boolean;
}

/** pawnio-dark and pawnio-light from the host theme; storm over either scheme. */
export const THEMES: readonly Theme[] = [
  { name: 'pawnio-dark', scheme: 'dark', storm: false },
  { name: 'pawnio-light', scheme: 'light', storm: false },
  { name: 'storm-dark', scheme: 'dark', storm: true },
  { name: 'storm-light', scheme: 'light', storm: true },
];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function primitiveHex(source: TokenTree, reference: string): string {
  const match = /^\{p\.([a-z0-9-]+)\}$/.exec(reference);
  const name = match?.[1];
  if (!name) throw new Error(`Semantic colors must reference a primitive, got ${reference}`);
  const primitives = source['p'];
  const token = isObject(primitives) ? primitives[name] : undefined;
  const value = isObject(token) ? token['$value'] : undefined;
  if (!isObject(value)) throw new Error(`Unknown primitive ${reference}`);
  if (typeof value['hex'] === 'string') return value['hex'];
  const [l = 0, c = 0, h = 0] = Array.isArray(value['components']) ? (value['components'] as number[]) : [];
  return formatHex({ mode: 'oklch', l, c, h });
}

/** Resolves every semantic color of one theme to sRGB hex (for contrast checks, not for CSS). */
export function resolveTheme(source: TokenTree, theme: Theme): Record<string, string> {
  const colors: Record<string, string> = {};
  const groups = theme.storm ? [source['color'], source['storm']] : [source['color']];
  for (const group of groups) {
    if (!isObject(group)) continue;
    for (const [name, token] of Object.entries(group)) {
      if (name.startsWith('$') || !isObject(token)) continue;
      const variant = token[theme.scheme];
      const reference = isObject(variant) ? variant['$value'] : undefined;
      if (typeof reference === 'string') colors[name] = primitiveHex(source, reference);
    }
  }
  return colors;
}

/** WCAG 2 contrast ratio. Throws on a color it cannot parse, so a missing token never passes. */
export function contrastRatio(foreground: string, background: string): number {
  if (!parse(foreground) || !parse(background)) throw new Error(`Cannot compare "${foreground}" with "${background}"`);
  return wcagContrast(foreground, background);
}
