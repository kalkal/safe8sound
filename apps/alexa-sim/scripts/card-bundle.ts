import { readdirSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';

// The card bundle the simulator inlines (#503): packages/ui-cards/dist/card-app.js, built by one command and never
// committed. A bundle older than its sources once kept the Home card empty on a PC (its strict schema refused a field
// added since, #487), and a deploy from that PC would have shipped it. The simulator's Vite config asks this before it
// serves or builds; `build:aws` and the E2E web server build the card first.

export const CARD_BUNDLE_FIX = 'pnpm --filter @cold-reserve/ui-cards build:card';

function statOf(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    // Not there: a source path that does not exist has nothing newer; a missing bundle is said by the caller.
    return undefined;
  }
}

/** The newest file under `path` (itself when it is a file), with its modification time. */
function newestUnder(path: string): { path: string; ms: number } | undefined {
  const stats = statOf(path);
  if (stats === undefined) return undefined;
  if (!stats.isDirectory()) return { path, ms: stats.mtimeMs };
  let newest: { path: string; ms: number } | undefined;
  for (const entry of readdirSync(path)) {
    const found = newestUnder(join(path, entry));
    if (found !== undefined && (newest === undefined || found.ms > newest.ms)) newest = found;
  }
  return newest;
}

/** What is wrong with the bundle, in words that say how to fix it; `undefined` when it is newer than every source. */
export function cardBundleProblem(bundle: string, sources: readonly string[]): string | undefined {
  const built = statOf(bundle);
  if (built === undefined) return `The card bundle ${bundle} is missing: run ${CARD_BUNDLE_FIX}.`;
  for (const source of sources) {
    const newest = newestUnder(source);
    if (newest !== undefined && newest.ms > built.mtimeMs) {
      return `The card bundle is older than its sources (${newest.path} changed since it was built): run ${CARD_BUNDLE_FIX}.`;
    }
  }
  return undefined;
}

/**
 * What the bundle is built from, relative to the repository root: the card package (its code, its build, its
 * dependencies), the packages it imports, and the lockfile, so a dependency update rebuilds it too.
 */
export const CARD_BUNDLE_SOURCES = [
  'packages/ui-cards/src',
  'packages/ui-cards/scripts',
  'packages/ui-cards/vite.card.config.ts',
  'packages/ui-cards/package.json',
  'packages/contracts/src',
  'packages/i18n/src',
  'packages/design-tokens/src',
  'packages/design-tokens/generated',
  'pnpm-lock.yaml',
] as const;
