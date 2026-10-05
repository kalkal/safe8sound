import { expect, test } from '../no-network.js';
import { AWS_SITE_URL, DEMO_CODE, SIM_API_URL } from './chain.js';

// K1 (#244 review): the AWS build of the site, its /api through the very CloudFront Function the distribution runs
// (a stand-in for CloudFront), and a REAL local sim-api configured as on AWS (no allowed origin) in front of the real
// agent (fake model) and MCP server. The browser's same-origin Origin must not cost the turn; a foreign one is refused.

test.use({ baseURL: AWS_SITE_URL });

test('a visitor enters the demo code and asks: sim-api answers through /api with the real chain', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Demo code').fill(DEMO_CODE);
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();
  // The fake model's answer comes from the MCP server's get_home_status, through the agent and sim-api.
  await expect(page.getByText(/Battery at \d+(\.\d+)?%/).last()).toBeVisible({ timeout: 20_000 });
});

test('#262: "Show my home" reads the sandbox home on demand through /api, read-only, marked SIMULATED', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Demo code').fill(DEMO_CODE);
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: 'Show my home' }).click();
  const home = page.getByRole('region', { name: 'My home' }).frameLocator('iframe[title="Home card"]').getByRole('region', { name: 'The home right now' });
  await expect(home.getByTestId('origin-badge')).toContainText('SIMULATED', { timeout: 20_000 });
  await expect(home.getByRole('list', { name: 'Energy' })).toContainText(/Battery \d+%/);
  await expect(home.getByRole('list', { name: 'Rooms' }).getByRole('listitem').first()).toBeVisible();
});

test('the privacy line about the access logs is readable at phone width, before the code is entered (#244)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const notice = page.getByText('This demo keeps your IP address in its access logs for 30 days, for security.');
  await expect(notice).toBeVisible();
  const box = await notice.boundingBox();
  expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 999) <= 375).toBe(true);
  // String expression: the e2e tsconfig has no DOM types.
  expect(await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')).toBe(true);
});

test('a request from another origin is refused at the edge, before sim-api', async ({ request }) => {
  const res = await request.post('/api/v1/session', { headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, data: { code: DEMO_CODE } });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ status: 403, code: 'origin_not_allowed' });
});

test('sim-api refuses a call that did not come through the site (#243): its URL is not usable directly', async ({ request }) => {
  const res = await request.post(`${SIM_API_URL}/v1/session`, { headers: { 'content-type': 'application/json' }, data: { code: DEMO_CODE } });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ code: 'origin_not_allowed' });
});
