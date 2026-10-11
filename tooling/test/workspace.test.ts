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

describe('workspace packages', () => {
  it('finds every package of the workspace, 22 of them with a packageName constant', () => {
    expect(packages.map((p) => p.folder)).toEqual(expect.arrayContaining(['packages/core', 'packages/adapters/store-memory', 'apps/mcp-server', 'infra']));
    expect(packages.length).toBeGreaterThanOrEqual(26);
    expect(packages.filter((p) => p.packageName !== undefined)).toHaveLength(22);
  });

  // A package with the packageName constant exports exactly ./src/index.ts; the others (design-tokens) any TypeScript source.
  it('are private ESM packages named after their folder, whose main entry is a TypeScript source (no build step)', () => {
    const wrong = packages.flatMap(({ folder, dir, manifest, packageName }) => {
      const main = manifest.exports?.['.'] ?? '';
      const problems = [
        manifest.name === `@cold-reserve/${basename(dir)}` ? '' : `name ${manifest.name}`,
        manifest.private === true ? '' : 'not private',
        manifest.type === 'module' ? '' : `type ${String(manifest.type)}`,
        (packageName === undefined ? /^\.\/.+\.ts$/.test(main) : main === './src/index.ts') && existsSync(join(dir, main)) ? '' : `main entry "${main}"`,
        packageName === undefined || packageName === manifest.name ? '' : `packageName ${packageName}`,
      ].filter(Boolean);
      return problems.length === 0 ? [] : [`${folder}: ${problems.join(', ')}`];
    });
    expect(wrong).toEqual([]);
  });
});
