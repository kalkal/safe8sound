// Architecture rules (plan §10.4, §14.2). Tested against a fixture tree in tooling/test.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Cycles make modules impossible to reason about and to extract.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'contracts-is-a-leaf',
      severity: 'error',
      comment: 'packages/contracts depends on Zod only.',
      from: { path: '^packages/contracts/src/' },
      to: { pathNot: ['^packages/contracts/', 'node_modules/zod/'] },
    },
    {
      name: 'core-and-guard-are-pure',
      severity: 'error',
      comment: 'core and guard know nothing of I/O, AWS, Home Assistant or MCP: only contracts, core and Zod.',
      from: { path: '^packages/(core|guard)/src/' },
      to: { pathNot: ['^packages/(contracts|core|guard)/', 'node_modules/zod/'] },
    },
    {
      name: 'core-does-not-depend-on-guard',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/guard/' },
    },
    {
      name: 'adapters-use-contracts-and-core-only',
      severity: 'error',
      comment: 'Adapters depend on contracts, core and their own libraries; energy profiles are shared data.',
      from: { path: '^packages/adapters/([^/]+)/' },
      to: {
        path: '^packages/',
        pathNot: ['^packages/(contracts|core)/', '^packages/adapters/$1/', '^packages/adapters/energy-profiles/'],
      },
    },
    {
      name: 'ui-cards-render-data-only',
      severity: 'error',
      from: { path: '^packages/ui-cards/' },
      to: { path: '^packages/(core|guard|adapters)/' },
    },
    {
      name: 'packages-do-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-do-not-import-each-other',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'nothing-imports-infra',
      severity: 'error',
      from: { path: '^(packages|apps|tooling)/' },
      to: { path: '^infra/' },
    },
    {
      name: 'src-uses-declared-dependencies',
      severity: 'error',
      comment: 'Production code imports only what its own package.json declares.',
      from: { path: ['^(packages|apps|infra)/[^/]+/src/', '^packages/adapters/[^/]+/src/'] },
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown', 'npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['(^|/)node_modules/', '(^|/)cdk\\.out/', '^tooling/test/fixtures/', '(^|/)generated/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.mjs', '.js', '.cjs', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
