import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runStudy } from '../../scripts/nights-study.js';

// Golden (C0, 18 Oct): the hottest storm nights study (#331) gives exactly the page committed in
// docs/results/storm-nights.md: every number the README and the video quote. A migration that moves a rounding or a
// °F formula (C2) shows here first. Never regenerated in a migration PR (`-u`). The page's date is the one it was
// generated on, read from the page, so `pnpm --filter @cold-reserve/mcp-server nights` keeps this test green.

const PAGE = '../../../../docs/results/storm-nights.md';

describe('golden: the hottest storm nights study', () => {
  it('runs every night again and gives the committed page, number for number', { timeout: 300_000 }, async () => {
    const committed = readFileSync(new URL(PAGE, import.meta.url), 'utf8');
    const generatedOn = /Generated on (\d{4}-\d{2}-\d{2})/.exec(committed)?.[1];
    expect(generatedOn, 'the page says when it was generated').toBeDefined();
    const { page } = await runStudy(generatedOn ?? '');
    await expect(page).toMatchFileSnapshot(PAGE);
  });
});
