import { expect, test, type Frame, type Page } from '@playwright/test';

const SHOTS = 'screenshots';

async function cardFrame(page: Page): Promise<Frame> {
  const handle = await page.locator('iframe[title="Plan card"]').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('card iframe not found');
  return frame;
}

async function openHost(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const frame = await cardFrame(page);
  await expect(frame.getByRole('heading', { name: /comfortable at least until 06:40/i })).toBeVisible();
  return { frame, errors };
}

const cardBackground = (frame: Frame) => frame.locator('.card').evaluate((el) => getComputedStyle(el).backgroundColor);
const accent = (frame: Frame) => frame.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--accent'));

test('renders the ui:// card in a sandboxed iframe, themed by hostContext, one screenshot per theme', async ({ page }) => {
  const { frame, errors } = await openHost(page);
  const iframe = page.locator('iframe[title="Plan card"]');

  // Sandbox: scripts only, opaque origin.
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await frame.evaluate(() => window.origin)).toBe('null');

  // pawnio-dark (default)
  await expect(frame.locator('html')).toHaveAttribute('data-card-theme', 'pawnio-dark');
  const darkBg = await cardBackground(frame);
  expect(darkBg).toMatch(/oklch\(0\.2076 0\.0135 258\.37\)|rgb\(20, 24, 30\)/);
  await iframe.screenshot({ path: `${SHOTS}/pawnio-dark.png` });

  // pawnio-light: only the host context changes, no reload of the card.
  await page.getByRole('button', { name: 'light', exact: true }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-card-theme', 'pawnio-light');
  const lightBg = await cardBackground(frame);
  expect(lightBg).not.toBe(darkBg);
  expect(lightBg).toMatch(/oklch\(1 0 0\)|rgb\(255, 255, 255\)/);
  await iframe.screenshot({ path: `${SHOTS}/pawnio-light.png` });

  // storm (dark): a new tool result with storm=true adds the storm theme on top of the scheme.
  await page.getByRole('button', { name: 'dark', exact: true }).click();
  const tealAccent = await accent(frame);
  await page.getByRole('button', { name: 'storm', exact: true }).click();
  await expect(frame.getByText(/storm mode · grid down since 19:40/i)).toBeVisible();
  await expect(frame.locator('html')).toHaveClass(/theme-storm/);
  expect(await accent(frame)).not.toBe(tealAccent);
  await expect(frame.getByRole('button', { name: 'Apply plan' })).toBeDisabled();
  await iframe.screenshot({ path: `${SHOTS}/storm.png` });

  // storm (light), for completeness of the matrix.
  await page.getByRole('button', { name: 'light', exact: true }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-card-theme', 'pawnio-light');
  await iframe.screenshot({ path: `${SHOTS}/storm-light.png` });

  expect(errors).toEqual([]);
});

test('shows the degraded state when the tool fails (fault injection: home unreachable)', async ({ page }) => {
  const { frame } = await openHost(page);
  await page.getByRole('button', { name: 'home-unreachable', exact: true }).click();
  const alert = frame.getByRole('alert');
  await expect(alert).toContainText('The latest home reading is 20 minutes old');
  await expect(alert).toContainText(/try again in a minute/i);
  await expect(alert).not.toContainText('home_data_stale');
  await page.locator('iframe[title="Plan card"]').screenshot({ path: `${SHOTS}/error.png` });
});

test('ignores postMessage traffic that does not come from the card frame', async ({ page }) => {
  const { frame } = await openHost(page);
  const iframe = page.locator('iframe[title="Plan card"]');
  const before = await iframe.evaluate((el) => el.getBoundingClientRect().height);

  // A forged size change from the host window itself (wrong source) must be rejected.
  await page.evaluate(() => window.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 5 } }, '*'));
  await expect(page.getByTestId('rejected-count')).toHaveText('1');
  await expect(page.getByTestId('rejected-reasons')).toHaveText('wrong_source');
  expect(await iframe.evaluate((el) => el.getBoundingClientRect().height)).toBe(before);

  // Genuine traffic from the card still works: Apply sends a log notification to the host.
  await frame.getByRole('button', { name: 'Apply plan' }).click();
  await expect(page.getByTestId('card-log')).toHaveText('apply requested');
});

test('the host CSP keeps the card off the network', async ({ page }) => {
  const { frame } = await openHost(page);
  const outcome = await frame.evaluate(() =>
    fetch('http://127.0.0.1:3100/mcp', { method: 'POST' }).then(
      () => 'reached',
      () => 'blocked',
    ),
  );
  expect(outcome).toBe('blocked');
});
