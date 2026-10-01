# Mutation testing
`pnpm heavy pnpm mutation <group...>` (or `--all`, only when the PC is idle) runs Stryker on the guard (`packages/guard`) and on the pacing, reserve, projection, night-recovery, planner and counterfactual modules of `packages/core`. The threshold is 80 %. Run it by hand or weekly, never on every push, and in slices: one or a few groups per call, each under 15 minutes, so other sessions can take the heavy lock in between.

It uses our script `tooling/src/mutation.mjs` instead of Stryker's Vitest runner:
- **Why a script.** `@stryker-mutator/vitest-runner` 10.0.0 runs no test per mutant with Vitest 5, so every mutant "survives" (see the [friction log](friction-log.md), 2026-09-29).
- **How it runs.** The script uses Stryker's command runner. Each group of sources is mutated against only the tests that exercise it, which keeps the run short enough for the heavy lock.
- **Sandbox aliases.** `vitest.stryker.config.ts` points the workspace packages at the sandbox sources: in Stryker's sandbox the pnpm links still point at the original checkout.
- **Out of scope.** The simulator physics in `packages/core` (F1) is left out: its mutants are only reached through slow projections.

Reports go to `reports/mutation/` (ignored by git).
