import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_BUNDLE_FIX, cardBundleProblem } from '../scripts/card-bundle.js';

// #503: the simulator inlines the card bundle (packages/ui-cards/dist/card-app.js, never committed). A bundle older than
// its sources once kept the Home card empty (its strict schema refused a field added since): the simulator's Vite config
// refuses to serve or build with one, and says how to fix it.

function world() {
  const root = mkdtempSync(join(tmpdir(), 'card-bundle-'));
  const bundle = join(root, 'dist', 'card-app.js');
  const sources = join(root, 'src');
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(sources, 'deep'), { recursive: true });
  const write = (path: string, seconds: number) => {
    writeFileSync(path, 'x');
    utimesSync(path, seconds, seconds);
  };
  return { bundle, sources, write };
}

describe('the card bundle is never older than its sources (#503)', () => {
  it('a bundle built after every source is fine', () => {
    const w = world();
    w.write(join(w.sources, 'a.ts'), 1_000);
    w.write(join(w.sources, 'deep', 'b.ts'), 2_000);
    w.write(w.bundle, 3_000);
    expect(cardBundleProblem(w.bundle, [w.sources])).toBeUndefined();
  });

  it('a source changed since the build, however deep, makes it stale, and names that source', () => {
    const w = world();
    w.write(join(w.sources, 'a.ts'), 1_000);
    w.write(w.bundle, 2_000);
    w.write(join(w.sources, 'deep', 'b.ts'), 3_000);
    const problem = cardBundleProblem(w.bundle, [w.sources]);
    expect(problem).toContain('b.ts');
    expect(problem).toContain(CARD_BUNDLE_FIX);
  });

  it('a missing bundle is a problem too, with the same fix', () => {
    const w = world();
    w.write(join(w.sources, 'a.ts'), 1_000);
    expect(cardBundleProblem(w.bundle, [w.sources])).toContain(CARD_BUNDLE_FIX);
  });

  it('a source path that is one file, or does not exist, is read as such', () => {
    const w = world();
    const config = join(w.sources, 'vite.card.config.ts');
    w.write(w.bundle, 2_000);
    w.write(config, 3_000);
    expect(cardBundleProblem(w.bundle, [config, join(w.sources, 'none')])).toContain('vite.card.config.ts');
  });

  it('the fix is the one command that builds it', () => {
    expect(CARD_BUNDLE_FIX).toBe('pnpm --filter @cold-reserve/ui-cards build:card');
  });
});
