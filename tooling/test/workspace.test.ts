import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every workspace package, checked once here instead of a copied package.test.ts in each package.
// One case over the whole table: a failure lists the packages.
const ROOT = join(import.meta.dirname, '..', '..');

// The `packages:` globs of pnpm-workspace.yaml, read as text: each one is `<folder>/*` or a single folder.
const workspaceYaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
const globs = [...(/^packages:\r?\n((?:[ \t]+- .+\r?\n)+)/m.exec(workspaceYaml)?.[1] ?? '').matchAll(/- ['"]?([^'"\s]+)/g)].map((m) => m[1] ?? '');
const folders = globs.flatMap((glob) => (glob.endsWith('/*') ? readdirSync(join(ROOT, glob.slice(0, -2))).map((name) => join(glob.slice(0, -2), name)) : [glob]));

interface Manifest {
  readonly name: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly exports?: Record<string, string>;
}

const packages = folders
  .filter((folder) => existsSync(join(ROOT, folder, 'package.json')))
  .map((folder) => {
    const dir = join(ROOT, folder);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
    // The skeleton constant `packageName` of src/index.ts, read as text so that no package is imported here.
    const entry = join(dir, 'src', 'index.ts');
    const packageName = existsSync(entry) ? /export const packageName = '([^']+)'/.exec(readFileSync(entry, 'utf8'))?.[1] : undefined;
    return { folder: folder.replaceAll('\\', '/'), dir, manifest, packageName };
  });

// The packages without the skeleton constant `packageName`: a shared leaf (contracts, i18n), generated tokens and the CDK app.
// Every other package must have it, and these must not (a stale exception fails), so a new package follows the strict rule without editing this test.
const WITHOUT_PACKAGE_NAME = ['packages/contracts', 'packages/design-tokens', 'packages/i18n', 'infra'];

describe('workspace packages', () => {
  it('finds at least one package for every glob of pnpm-workspace.yaml', () => {
    expect(globs.length).toBeGreaterThan(0);
    const empty = globs.filter((glob) => !packages.some((p) => p.folder === glob || p.folder.startsWith(glob.replace(/\*$/, ''))));
    expect(empty).toEqual([]);
  });

  it('lists only existing packages as exceptions to the strict rule', () => {
    expect(WITHOUT_PACKAGE_NAME.filter((folder) => !packages.some((p) => p.folder === folder))).toEqual([]);
  });

  // The strict rule (packageName constant, main entry exactly ./src/index.ts) holds for every package but the listed exceptions,
  // which still need a TypeScript source as main entry.
  it('are private ESM packages named after their folder, whose main entry is a TypeScript source (no build step)', () => {
    const wrong = packages.flatMap(({ folder, dir, manifest, packageName }) => {
      const main = manifest.exports?.['.'] ?? '';
      const strict = !WITHOUT_PACKAGE_NAME.includes(folder);
      const problems = [
        manifest.name === `@cold-reserve/${basename(dir)}` ? '' : `name ${manifest.name}`,
        manifest.private === true ? '' : 'not private',
        manifest.type === 'module' ? '' : `type ${String(manifest.type)}`,
        (strict ? main === './src/index.ts' : /^\.\/.+\.ts$/.test(main)) && existsSync(join(dir, main)) ? '' : `main entry "${main}"`,
        (strict ? packageName === manifest.name : packageName === undefined) ? '' : `packageName ${String(packageName)}`,
      ].filter(Boolean);
      return problems.length === 0 ? [] : [`${folder}: ${problems.join(', ')}`];
    });
    expect(wrong).toEqual([]);
  });
});
