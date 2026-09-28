# Cold Reserve (working name)

A voice agent that turns a home battery into a **comfort reserve**: it pre-cools the rooms people will use with solar surplus, paces the stored energy until the sun (or the grid) comes back, and keeps a safe room comfortable during a storm blackout — with deterministic guarantees, not promises.

Built for the Amazon "Build, Ship, Shape" hackathon, Alexa+ track: an MCP server (spec 2025-11-25, Streamable HTTP), a simulated Alexa+ experience, and an Alexa Skill bridge.

Work is tracked in [issues](https://github.com/kalkal/cold-reserve/issues) and [milestones](https://github.com/kalkal/cold-reserve/milestones).

## Repository layout
```
packages/
  contracts/      Zod schemas, branded units, error codes and envelopes (leaf)
  core/ guard/    pure domain and composable guard constraints
  i18n/           message catalogs
  design-tokens/  tokens.json (W3C DTCG) -> CSS custom properties + typed names
  ui-cards/       MCP Apps card components (tokens only)
  adapters/*      data sources, stores, weather, notifier
apps/             mcp-server, agent, sim-api, ingest-api, jobs, alexa-sim, home-bridge
infra/            AWS CDK app (dev and demo stages, cdk-nag), synth only
tooling/          repo scripts: secret scan, heavy lock, hook install
spikes/           throwaway spike code, outside the workspace
```

## Run locally
Requires Node 22 and pnpm 12 (`corepack enable`).
```bash
pnpm install          # also points git at .githooks
pnpm typecheck
pnpm lint && pnpm lint:css && pnpm depcruise
pnpm test             # or: pnpm test packages/contracts
pnpm synth            # cdk synth + cdk-nag, no AWS account needed
pnpm tokens           # rebuild design tokens after editing tokens.json
```
