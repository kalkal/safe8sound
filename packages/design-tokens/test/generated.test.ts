import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTokens } from '../src/build.js';
import { renderTokenModule } from '../src/module.js';
import { loadTokenSource } from '../src/source.js';
import { TOKEN_NAMES } from '../generated/tokens.js';

const read = (file: string) => readFileSync(new URL(`../generated/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('committed generated files', () => {
  it('match a fresh build of tokens.json (run `pnpm tokens` after editing tokens)', async () => {
    const result = await buildTokens(loadTokenSource());
    if (!result.ok) throw new Error(result.error.message);
    expect(read('tokens.css')).toBe(result.value.css);
    expect(read('tokens.ts')).toBe(renderTokenModule(result.value.names));
  });

  it('export the typed list of token names', () => {
    expect(TOKEN_NAMES).toEqual(expect.arrayContaining(['surface-card', 'accent', 'radius-card', 'font-body']));
  });
});
