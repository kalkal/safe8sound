import type { Page } from '@playwright/test';
import { expect, test } from '../no-network.js';

// "Not now" on the plan card (#348): the card folds to one honest line and nothing reaches the host, so nothing in
// the home changes; on a last resort it is never an apply. The page records every JSON-RPC method the card frames
// send to the host (MCP Apps over postMessage), so the test sees that no tools/call left the card. ScriptedAgent only.

async function recordCardMessages(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The e2e project has no DOM types: the page's window, typed by what this script uses.
    const host = globalThis as unknown as {
      top: unknown;
      cardMethods?: string[];
      addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
    };
    if (host !== host.top) return;
    const methods: string[] = [];
    host.cardMethods = methods;
    host.addEventListener('message', ({ data }) => {
      if (typeof data === 'object' && data !== null && 'method' in data && typeof data.method === 'string') methods.push(data.method);
    });
  });
}

const cardMethods = (page: Page) => page.evaluate(() => (globalThis as unknown as { cardMethods: string[] }).cardMethods);

for (const { name, question, apply } of [
  { name: 'a hot-day plan', question: "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.", apply: 'Apply plan' },
  { name: 'a last resort', question: 'Last resort for a hot night', apply: 'Apply the last-resort plan' },
]) {
  test(`"Not now" on ${name}: the card says the plan was not applied, and no tool is called`, async ({ page }) => {
    await recordCardMessages(page);
    await page.goto('/');
    const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
    await page.getByLabel('Ask a question').fill(question);
    await page.getByRole('button', { name: 'Ask' }).click();

    const card = page.frameLocator('iframe[title="Plan card"]');
    const plan = card.getByRole('region', { name: 'Plan' });
    await expect(plan.getByRole('button', { name: apply })).toBeVisible();
    await plan.getByRole('button', { name: 'Not now' }).click();

    await expect(card.getByRole('status').filter({ hasText: 'Plan not applied — ask again any time.' })).toBeVisible();
    // Still the plan card (its title row keeps the way back in full screen), without the plan.
    await expect(plan.getByTestId('plan-dismissed')).toBeVisible();
    await expect(plan.getByTestId('plan-horizon')).toHaveCount(0);
    // The plan is still known, so the folded card keeps its data badge (#193).
    await expect(plan.getByTestId('origin-badge')).toHaveText(/SIMULATED/);
    await expect(card.getByRole('region', { name: 'Safety check' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: apply })).toHaveCount(0);
    await expect(card.locator('body')).not.toContainText('Not applied yet');
    await expect(card.locator('body')).not.toContainText('Plan applied.');
    // The recorder hears the card (it connected through the bridge), and the card never asked the host for a tool.
    const methods = await cardMethods(page);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods).not.toContain('tools/call');
    // A last resort alerts the family only once applied: nothing was sent.
    await expect(phone.getByText('No messages from Safe-8-Sound yet.')).toBeVisible();
  });
}

// The folded line with its badge fits the frame: no horizontal overflow on a small Echo or a phone (#193).
for (const [width, height] of [
  [960, 480],
  [375, 700],
] as const) {
  test(`at ${String(width)} × ${String(height)} the folded plan line and its badge stay inside the frame`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
    await page.getByRole('button', { name: 'Ask' }).click();
    const card = page.frameLocator('iframe[title="Plan card"]');
    const plan = card.getByRole('region', { name: 'Plan' });
    await plan.getByRole('button', { name: 'Not now' }).click();
    const badge = plan.getByTestId('origin-badge');
    await expect(badge).toBeVisible();
    const box = await plan.boundingBox();
    const badgeBox = await badge.boundingBox();
    const frameBox = await page.locator('iframe[title="Plan card"]').boundingBox();
    expect(badgeBox && box && badgeBox.x + badgeBox.width <= box.x + box.width + 0.5, 'badge inside the card').toBe(true);
    expect(box && frameBox && box.x + box.width <= frameBox.x + frameBox.width + 0.5, 'card inside the frame').toBe(true);
    const overflow = await card.locator('body').evaluate((el: { scrollWidth: number; clientWidth: number }) => el.scrollWidth - el.clientWidth);
    expect(overflow, 'no horizontal overflow in the frame').toBeLessThanOrEqual(0);
  });
}
