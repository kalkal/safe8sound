import { test as base, expect } from '@playwright/test';

// Screenshots with cards: never `fullPage: true`. Headless Chrome paints sandboxed ui:// iframes squeezed into a
// narrow column in a full-page capture while the DOM is correct (#231, a false alarm). Take viewport or
// element screenshots (`locator.screenshot()`), and check widths with boundingBox(), not with pictures.

/**
 * Every E2E page runs offline: any request that leaves the dev server is aborted and fails the test.
 * A test ends with what it found plus Playwright's own context and its one page: a second page, popup or context it
 * opened and left open is closed here and fails the test, so a leak is a red test, not a pile of Chrome processes
 * (20 Oct). Contexts open before the test (a journey's, from its beforeAll) are not the test's.
 */
export const test = base.extend<{ externalRequests: string[]; noLeftovers: undefined }>({
  noLeftovers: [
    async ({ browser, context }, use) => {
      const before = new Set(browser.contexts());
      await use(undefined);
      const contexts = browser.contexts().filter((c) => c !== context && !before.has(c));
      const pages = context.pages().slice(1);
      await Promise.all([...pages.map((p) => p.close()), ...contexts.map((c) => c.close())]);
      expect({ pages: pages.length, contexts: contexts.length }, 'pages and contexts the test left open').toEqual({ pages: 0, contexts: 0 });
    },
    { auto: true },
  ],
  externalRequests: [
    async ({ context, baseURL }, use) => {
      const escaped: string[] = [];
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (baseURL !== undefined && url.startsWith(baseURL)) return route.fallback();
        escaped.push(url);
        return route.abort('blockedbyclient');
      });
      await use(escaped);
      expect(escaped, 'requests outside the dev server').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
