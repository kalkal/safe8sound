import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import { packageName } from '../src/index.js';

describe('@cold-reserve/ui-cards skeleton', () => {
  it('is a private ESM workspace package named after its folder', () => {
    expect(packageName).toBe(manifest.name);
    expect(manifest).toMatchObject({ private: true, type: 'module', exports: { '.': './src/index.ts' } });
  });
});
