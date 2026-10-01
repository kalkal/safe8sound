import type { Page } from '@playwright/test';
import { expect } from './no-network.js';

// Remote mode starts with the demo code (#101). sim-api is intercepted at the dev server's /sim-api path:
// these tests never start a real backend (the real chain is covered by apps/alexa-sim/test/e2e).
export const DEMO_CODE = 'e2e-demo-code-0001';
export const DEMO_TOKEN = 'e2e.demo.token';

/** Opens the simulator in remote mode and enters the demo code, so the question field is ready. */
export async function openRemote(page: Page): Promise<void> {
  await page.route('**/sim-api/v1/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: DEMO_TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) }),
  );
  await page.goto('/?agent=remote');
  await page.getByLabel('Demo code').fill(DEMO_CODE);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByLabel('Ask a question')).toBeVisible();
}
