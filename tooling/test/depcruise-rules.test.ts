import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cruise, type IReporterOutput } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../.dependency-cruiser.cjs') as { forbidden: unknown[] };
const fixtures = fileURLToPath(new URL('./fixtures/depcruise/', import.meta.url));

async function violations(): Promise<Array<{ rule: string; from: string; to: string }>> {
  const result: IReporterOutput = await cruise(['packages', 'apps'], {
    baseDir: fixtures,
    ruleSet: { forbidden: config.forbidden } as never,
    validate: true,
  });
  if (typeof result.output === 'string') throw new Error('expected a cruise result object');
  return result.output.summary.violations.map((v) => ({ rule: v.rule.name, from: v.from, to: v.to }));
}

describe('dependency-cruiser: architecture rules (plan §10.4, §14.2)', () => {
  it('flags each forbidden edge of the fixture tree with its rule', async () => {
    const found = await violations();
    const rules = (from: string) => found.filter((v) => v.from.startsWith(from)).map((v) => v.rule);
    expect(rules('packages/core/src/uses-io.ts')).toContain('core-and-guard-are-pure');
    expect(rules('packages/core/src/uses-guard.ts')).toContain('core-does-not-depend-on-guard');
    expect(rules('packages/contracts/src/uses-core.ts')).toContain('contracts-is-a-leaf');
    expect(rules('apps/alpha/src/uses-beta.ts')).toContain('apps-do-not-import-each-other');
    expect(rules('packages/adapters/store-memory/src/uses-guard.ts')).toContain('adapters-use-contracts-and-core-only');
    expect(rules('packages/guard/src/uses-app.ts')).toContain('packages-do-not-import-apps');
    expect(rules('packages/adapters/store-memory/src/uses-testing.ts')).toContain('src-never-imports-test-support');
    expect(found.map((v) => v.rule)).toContain('no-circular');
  });

  it('allows the edges the architecture wants', async () => {
    const found = await violations();
    const allowed = ['packages/guard/src/uses-core.ts', 'packages/adapters/store-memory/src/uses-core.ts', 'apps/alpha/src/uses-contracts.ts'];
    expect(found.filter((v) => allowed.includes(v.from))).toEqual([]);
  });
});

describe('dependency-cruiser: the device layout is a template another can replace (separation step S2, #432)', () => {
  const A = 'apps/alexa-sim/src/';
  it('logic never imports a layout; a layout never imports logic nor another layout', async () => {
    const found = await violations();
    const rules = (from: string) => found.filter((v) => v.from === A + from).map((v) => v.rule);
    expect(rules('ui/uses-layout.ts')).toContain('logic-never-imports-layouts');
    expect(rules('layouts/echo/uses-state.ts')).toContain('layouts-are-presentational');
    expect(rules('layouts/plain/uses-echo.ts')).toContain('layouts-do-not-import-each-other');
    expect(rules('ui/uses-registry.ts')).toContain('only-the-root-chooses-a-layout');
    expect(rules('layouts/echo/uses-io.ts')).toContain('layouts-are-presentational');
  });

  it('only the root and the registry choose a layout; a layout may use the surface and the shared ui', async () => {
    const found = await violations();
    const allowed = ['main.tsx', 'surface/registry.ts', 'layouts/plain/uses-ui.ts'].map((f) => A + f);
    expect(found.filter((v) => allowed.includes(v.from))).toEqual([]);
  });
});
