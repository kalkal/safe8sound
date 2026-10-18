import type { Browser, BrowserContext, Page } from '@playwright/test';
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
  return { context, page: await context.newPage(), escaped };
}

/** Enters the demo code at the site's door (S: the access to the site, neither product nor demo control). */
export async function enterCode(page: Page): Promise<void> {
  await page.getByLabel('Demo code').fill(demoCode());
  await page.getByRole('button', { name: 'Start' }).click();
}
