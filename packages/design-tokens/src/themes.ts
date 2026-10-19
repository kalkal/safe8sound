import { converter, formatHex, parse, wcagContrast } from 'culori';
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
const rgb = converter('rgb');
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A resolved color with its opacity: what a translucent surface needs to be composited over what is behind it. */
export interface Rgba {
  hex: string;
  alpha: number;
}

function primitive(source: TokenTree, reference: string): Rgba {
  const match = /^\{p\.([a-z0-9-]+)\}$/.exec(reference);
  const name = match?.[1];
  if (!name) throw new Error(`Semantic colors must reference a primitive, got ${reference}`);
  const primitives = source['p'];
  const token = isObject(primitives) ? primitives[name] : undefined;
  const value = isObject(token) ? token['$value'] : undefined;
  if (!isObject(value)) throw new Error(`Unknown primitive ${reference}`);
  const alpha = typeof value['alpha'] === 'number' ? value['alpha'] : 1;
  if (typeof value['hex'] === 'string') return { hex: value['hex'], alpha };
  const [l = 0, c = 0, h = 0] = Array.isArray(value['components']) ? (value['components'] as number[]) : [];
  return { hex: formatHex({ mode: 'oklch', l, c, h }), alpha };
}

/** Every semantic color of one theme with its opacity (for compositing checks, not for CSS). */
export function resolveThemeRgba(source: TokenTree, theme: Theme): Record<string, Rgba> {
  const colors: Record<string, Rgba> = {};
  const groups = theme.storm ? [source['color'], source['storm']] : [source['color']];
  for (const group of groups) {
    if (!isObject(group)) continue;
    for (const [name, token] of Object.entries(group)) {
      if (name.startsWith('$') || !isObject(token)) continue;
      const variant = token[theme.scheme];
      const reference = isObject(variant) ? variant['$value'] : undefined;
      if (typeof reference === 'string') colors[name] = primitive(source, reference);
    }
  }
  return colors;
}

/** Resolves every semantic color of one theme to sRGB hex (for contrast checks, not for CSS). */
export function resolveTheme(source: TokenTree, theme: Theme): Record<string, string> {
  return Object.fromEntries(Object.entries(resolveThemeRgba(source, theme)).map(([name, color]) => [name, color.hex]));
}

/** The opaque stops of a gradient token in one theme, in order. Throws on an unknown gradient. */
export function gradientStops(source: TokenTree, theme: Theme, name: string): string[] {
  const group = source['gradient'];
  const token = isObject(group) ? group[name] : undefined;
  const variant = isObject(token) ? token[theme.scheme] : undefined;
  const stops = isObject(variant) ? variant['$value'] : undefined;
  if (!Array.isArray(stops)) throw new Error(`Unknown gradient ${name}`);
  return stops.map((stop: unknown) => {
    const color = isObject(stop) ? stop['color'] : undefined;
    if (typeof color !== 'string') throw new Error(`Gradient ${name} has a stop without a primitive color`);
    const resolved = primitive(source, color);
    if (resolved.alpha < 1) throw new Error(`Gradient ${name} has a translucent stop: it cannot be composited as an opaque colour`);
    return resolved.hex;
  });
}

/** `top` painted over the opaque `bottom`, blended per channel in sRGB as the browser composites it. */
export function over(top: Rgba, bottom: string): string {
  const front = rgb(parse(top.hex));
  const back = rgb(parse(bottom));
  if (!front || !back) throw new Error(`Cannot composite "${top.hex}" over "${bottom}"`);
  const mix = (f: number, k: number) => f * top.alpha + k * (1 - top.alpha);
  return formatHex({ mode: 'rgb', r: mix(front.r, back.r), g: mix(front.g, back.g), b: mix(front.b, back.b) });
}

/** WCAG 2 contrast ratio. Throws on a color it cannot parse, so a missing token never passes. */
export function contrastRatio(foreground: string, background: string): number {
  if (!parse(foreground) || !parse(background)) throw new Error(`Cannot compare "${foreground}" with "${background}"`);
  return wcagContrast(foreground, background);
}
