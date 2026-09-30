import { expect, test } from '../no-network.js';

// Fault injection (error-handling §7): the remote agent fails → scripted answer + a clear notice.
// `?agent=remote` works only on the dev server; sim-api is intercepted at the same origin.

const ask = async (page: import('@playwright/test').Page) => {
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();
};

test('sim-api answers 503 → degraded scripted answer, still marked SIMULATED', async ({ page }) => {
  await page.route('**/sim-api/v1/turns', (route) => route.fulfill({ status: 503, body: 'Service Unavailable' }));
  await page.goto('/?agent=remote');
  await ask(page);

  await expect(page.getByRole('note')).toHaveText("I can't reach the assistant right now, so this is a scripted answer.");
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
  await expect(page.getByTestId('origin-badge')).toHaveText('≈ SIMULATED');
});

test('sim-api sends malformed JSON → degraded scripted answer', async ({ page }) => {
  await page.route('**/sim-api/v1/turns', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"text":' }));
  await page.goto('/?agent=remote');
  await ask(page);

  await expect(page.getByRole('note')).toBeVisible();
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
});

test('sim-api answers → the remote reply is shown with its own origin, no notice', async ({ page }) => {
  const reply = {
    text: 'Your battery is at 64 percent.',
    status: { batterySocPct: 64, origin: { energy: 'live', rooms: 'live', weather: 'live' }, ts: '2026-07-15T18:05:00+02:00' },
  };
  let correlationId: string | null = null;
  await page.route('**/sim-api/v1/turns', (route) => {
    correlationId = route.request().headers()['x-correlation-id'] ?? null;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) });
  });
  await page.goto('/?agent=remote');
  await ask(page);

  await expect(page.getByTestId('battery-soc')).toHaveText('64%');
  await expect(page.getByTestId('origin-badge')).toHaveText('LIVE');
  await expect(page.getByRole('note')).toHaveCount(0);
  expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
});

test('sim-api quota exceeded → a calm message and one retry, not a scripted answer', async ({ page }) => {
  const problem = {
    type: 'urn:cold-reserve:problem:demo_quota_exceeded',
    title: 'Too many requests',
    status: 429,
    detail: 'The demo quota is used up.',
    instance: 'c1',
    code: 'demo_quota_exceeded',
  };
  await page.route('**/sim-api/v1/turns', (route) =>
    route.fulfill({ status: 429, contentType: 'application/problem+json', body: JSON.stringify(problem) }),
  );
  await page.goto('/?agent=remote');
  await ask(page);

  await expect(page.getByRole('alert')).toContainText("I can't answer right now. Try again in a moment.");
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByLabel('Ask a question')).toBeFocused();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(page.getByTestId('answer')).toHaveCount(0);
});

test('sim-api down + "Apply the plan" → an honest answer: nothing claimed as applied, no card', async ({ page }) => {
  await page.route('**/sim-api/v1/turns', (route) => route.fulfill({ status: 503, body: 'Service Unavailable' }));
  await page.goto('/?agent=remote');
  await page.getByLabel('Ask a question').fill('Apply the plan');
  await page.getByRole('button', { name: 'Ask' }).click();

  await expect(page.getByRole('note')).toHaveText("I can't reach the assistant right now, so this is a scripted answer.");
  await expect(page.getByTestId('answer')).toContainText("I can't reach the assistant right now, so I can't do that. Nothing was changed.");
  await expect(page.getByText('Plan applied.')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Plan' })).toHaveCount(0);
});
