# Spike S3 · MCP Apps card in a React host, styled only by DTCG tokens

Throwaway code for issue #7. Not part of the future workspace.

## What it proves
- A minimal stateless MCP server (low-level `Server`, SDK 1.30.1, as in S1) serves `ui://cold-reserve/plan-card` (`text/html;profile=mcp-app`) and a `plan_comfort` tool linked to it through `_meta.ui.resourceUri` (plus the legacy `ui/resourceUri` key). `outputSchema` stays `anyOf [plan, error envelope]`.
- A React host page reads the resource, injects its **own** CSP (built from `_meta.ui.csp`, deny by default), renders it in `<iframe sandbox="allow-scripts" srcdoc>` (opaque origin `null`) and talks to it through `@modelcontextprotocol/ext-apps` `AppBridge` over a validating transport (`FrameTransport`: right window, origin `null`, JSON-RPC 2.0, size cap, a reason for every rejection).
- The card (React + `useApp`) takes the theme from `hostContext.theme` (`data-card-theme="pawnio-dark|pawnio-light"`) and the storm theme from the tool result (`.theme-storm`).
- All styling comes from `tokens/tokens.json` (W3C DTCG 2025.10, oklch colors) → Style Dictionary 5.5.5 → `generated/tokens.css`: `@layer tokens`, `light-dark()` for every semantic color, gradient stops as `light-dark()`, storm overrides only `accent` and `cube-fill`. `card.css` reads only semantic tokens (checked by a test), uses `@layer`, `color-mix(in oklab)`, container queries with `cqi`, native nesting, `:has()`, logical properties and `prefers-reduced-motion`.

## Run
```
pnpm install
pnpm test            # 130 unit tests (tokens, AA contrast x4 themes, card css rules, card view, server, CSP, frame guard)
pnpm typecheck
pnpm test:e2e        # builds tokens + card, starts server (3100) and host (5173), 4 Playwright tests on the installed Chrome
```
Screenshots of the last E2E run: `screenshots/` (pawnio-dark, pawnio-light, storm, storm-light, error).

## Findings (details in the verdict on #7)
1. **ext-apps 2.x needs the split MCP SDK v2** (`@modelcontextprotocol/core|client|server` ^2). With SDK 1.30.1 use **ext-apps 1.7.5** (peer `@modelcontextprotocol/sdk ^1.29`).
2. ext-apps 1.7.5 `.d.ts` files use extensionless relative imports: with `moduleResolution: NodeNext` `useApp` and friends disappear. Use `Bundler` resolution for card/host code.
3. `AppBridge.setHostContext()` before `connect()` leaves an unhandled "Not connected" rejection: pass the initial context in `new AppBridge(..., { hostContext })`.
4. Style Dictionary 5.5.5 reads DTCG 2025.10 color objects (oklch, alpha, hex fallback) and dimension objects; its `color/oklch` transform prints `oklch()`. **Gradients and duration objects are not handled by the CSS transforms** (`[object Object]`): a ~150-line custom format covers them and the `light-dark()` pairing.
5. `light-dark()` accepts colors only: gradients become `linear-gradient(angle, light-dark(a, b) p%, …)`; the angle lives in `$extensions` (DTCG gradients have none), and both schemes must share stop positions.
6. `color-mix(in oklch, …)` with white/grays (hue 0 in the tokens) drifts toward pink: mix in **oklab**.
7. Container query conditions cannot read custom properties: breakpoints stay literal in `@container` preludes (the one allowed exception).
8. The card bundle is 873 kB (197 kB gzip) with React + SDK + Zod 4 inlined: fine locally, worth trimming in F8.
9. Chrome paints an opaque backdrop behind an iframe whose `color-scheme` differs from the card's: the host sets the iframe `color-scheme` to the card theme.
