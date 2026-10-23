import { appendFileSync, mkdirSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { CARD_TOOL_ACCESS, DEMO_CLOCK_TOOLS } from '../../packages/contracts/src/index.js';
import { SITE_URL, demoCode } from './target.js';
import type { Size } from './sizes.js';

/** The browser's zone is neither the home's (Houston) nor the place the site was built in. */
export const VIEWER_ZONE = 'Asia/Tokyo';

export interface SiteSession {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Every request that tried to leave the site (outcome O13): a journey ends with it empty. */
  readonly escaped: string[];
}

/**
 * One visit to the AWS build of the site at one size, kept for a whole journey. The same offline guard as every E2E
 * page (e2e/no-network.ts): anything that leaves the site is aborted and recorded.
 */
export async function openSiteSession(browser: Browser, size: Size): Promise<SiteSession> {
  const context = await browser.newContext({ baseURL: SITE_URL, viewport: { width: size.width, height: size.height }, timezoneId: VIEWER_ZONE });
  const escaped: string[] = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(SITE_URL)) return route.fallback();
    escaped.push(url);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  countCalls(page, size);
  return { context, page, escaped };
}

/** The tools sim-api counts on the demo counter (the contract's DEMO_CLOCK_TOOLS): the clock and the scenario. */
const DEMO_TOOLS: ReadonlySet<string> = new Set(DEMO_CLOCK_TOOLS);

/**
 * Writes one line per metered call of the visit to e2e-results/calls-<size>.jsonl: its kind (turn, read, write or demo, as
 * the daily caps count them) and the status; never a body, an id or the code. `sort | uniq -c` of the file sizes a take.
 */
function countCalls(page: Page, size: Size): void {
  mkdirSync('e2e-results', { recursive: true });
  page.on('response', (res) => {
    const request = res.request();
    if (request.method() !== 'POST') return;
    const path = new URL(res.url()).pathname;
    let line: Record<string, unknown> | undefined;
    if (path.endsWith('/v1/turns')) line = { kind: 'turn' };
    else if (path.endsWith('/v1/tools/call')) {
      const name = (request.postDataJSON() as { name?: unknown } | null)?.name;
      const tool = typeof name === 'string' ? name : 'unknown';
      line = { kind: DEMO_TOOLS.has(tool) ? 'demo' : (CARD_TOOL_ACCESS as Readonly<Record<string, string>>)[tool] ?? 'unknown', tool };
    }
    if (line !== undefined) appendFileSync(`e2e-results/calls-${size.id}.jsonl`, JSON.stringify({ ...line, status: res.status() }) + String.fromCharCode(10));
  });
}

/** Enters the demo code at the site's door (S: the access to the site, neither product nor demo control). */
export async function enterCode(page: Page): Promise<void> {
  await page.getByLabel('Demo code').fill(demoCode());
  await page.getByRole('button', { name: 'Start' }).click();
}
