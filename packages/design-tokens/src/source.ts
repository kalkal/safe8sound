import { readFileSync } from 'node:fs';

export type TokenTree = Record<string, unknown>;

/** Reads packages/design-tokens/tokens.json, the only file to edit to change the style. */
export function loadTokenSource(): TokenTree {
  return JSON.parse(readFileSync(new URL('../tokens.json', import.meta.url), 'utf8')) as TokenTree;
}
