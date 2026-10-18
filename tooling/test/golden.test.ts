import { describe, expect, it } from 'vitest';
import { goldenFiles, goldenName, selectGolden } from '../src/golden.mjs';

const FILES = ['apps/mcp-server/test/golden/tools.golden.test.ts', 'apps/mcp-server/test/golden/nights.golden.test.ts', 'packages/ui-cards/test/golden/cards.golden.test.tsx'];

describe('pnpm golden', () => {
  it('names a golden test by its base name, ts or tsx', () => {
    expect(FILES.map(goldenName)).toEqual(['tools', 'nights', 'cards']);
  });

  it('runs every golden test with no name, only the named ones otherwise', () => {
    expect(selectGolden(FILES, [])).toEqual({ ok: true, files: FILES });
    expect(selectGolden(FILES, ['cards', 'tools'])).toEqual({ ok: true, files: [FILES[0], FILES[2]] });
  });

  it('refuses a name that matches no golden test, saying which', () => {
    expect(selectGolden(FILES, ['tools', 'nope'])).toEqual({ ok: false, unknown: ['nope'] });
  });

  it('finds the golden tests of the repo, only under test/golden', () => {
    const files = goldenFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.every((f) => f.includes('/test/golden/') && /\.golden\.test\.tsx?$/.test(f))).toBe(true);
  });
});
