import { expect, test } from '../no-network.js';
import { AWS_SITE_URL, DEMO_CODE, SIM_API_URL } from './chain.js';
import { toCardPage } from '../card-pages.js';
import { demoControls, demoControlsButton } from '../surface.js';

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
  // The rooms are the home card's page 2 (pages instead of scrolling, owner 10 Oct).
  await toCardPage(page.getByRole('region', { name: 'My home' }).frameLocator('iframe[title="Home card"]'), 2);
  await expect(home.getByRole('list', { name: 'Rooms' }).getByRole('listitem').first()).toBeVisible();
});

test('B2: the settings drawer saves to the visitor sandbox through /api; the badge shows what the server reads back', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Demo code').fill(DEMO_CODE);
  await page.getByRole('button', { name: 'Start' }).click();
  // Each demo session plays its own sandbox: the badge comes from its get_demo_settings.
  const badge = demoControlsButton(page);
  await expect(badge).toContainText('Reference home (central Italy)', { timeout: 20_000 });

  await badge.click();
  const drawer = demoControls(page);
  await drawer.getByText('Storm · power outage').click();
  // set_scenario, then get_demo_settings: the badge and the checked radio are what is stored.
  await expect(badge).toContainText('Storm · power outage', { timeout: 20_000 });
  await expect(drawer.getByRole('radio', { name: /Storm/ })).toBeChecked();
  await expect(page.getByTestId('echo-screen')).toHaveAttribute('data-sky', 'storm');
  // Turin and Houston ship with #280: a new place is saved too, and the badge names it as the server does.
  await drawer.getByText('Houston, Texas').click();
  await expect(badge).toContainText('Houston, Texas', { timeout: 20_000 });
  await drawer.getByRole('radiogroup', { name: 'Temperature units' }).getByText('°F').click();
  await expect(drawer.getByRole('radio', { name: '°F' })).toBeChecked({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(badge).toBeFocused();
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
