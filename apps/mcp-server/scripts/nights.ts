import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runStudy } from './nights-study.js';

// The hottest storm nights (#331): runs the study and writes docs/results/storm-nights.md.
// Usage: pnpm --filter @cold-reserve/mcp-server nights [YYYY-MM-DD]   (the date printed on the page; default today)
// The study's inputs (nights, charges, sleepers) live in nights-study.ts, so its golden test runs the same study.

const started = performance.now();
const generatedOn = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const { page, runs } = await runStudy(generatedOn);
const seconds = (performance.now() - started) / 1000;

const out = fileURLToPath(new URL('../../../docs/results/storm-nights.md', import.meta.url));
mkdirSync(fileURLToPath(new URL('../../../docs/results/', import.meta.url)), { recursive: true });
writeFileSync(out, page);
console.log(`${String(runs)} night runs in ${seconds.toFixed(1)} s; wrote docs/results/storm-nights.md`);
