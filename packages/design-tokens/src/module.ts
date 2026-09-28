/** Source of generated/tokens.ts: the typed list of custom properties components may read. */
export function renderTokenModule(names: readonly string[]): string {
  return [
    '// Generated from tokens.json by `pnpm tokens`. Do not edit.',
    `export const TOKEN_NAMES = ${JSON.stringify(names, null, 2)} as const;`,
    'export type TokenName = (typeof TOKEN_NAMES)[number];',
    '',
  ].join('\n');
}
