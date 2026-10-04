import { test as base, expect } from '@playwright/test';

// Screenshots with cards: never `fullPage: true`. Headless Chrome paints sandboxed ui:// iframes squeezed into a
// narrow column in a full-page capture while the DOM is correct (#231, a false alarm). Take viewport or
// element screenshots (`locator.screenshot()`), and check widths with boundingBox(), not with pictures.

/** Every E2E page runs offline: any request that leaves the dev server is aborted and fails the test. */
export const test = base.extend<{ externalRequests: string[] }>({
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
