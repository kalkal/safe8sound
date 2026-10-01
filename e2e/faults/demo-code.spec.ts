import { expect, test } from '../no-network.js';
import { DEMO_CODE, DEMO_TOKEN, openRemote } from '../remote-session.js';

// The demo code gate of remote mode (#101, main's decision): shown only without a token, 48 px, show/hide,
// never autocompleted, emptied after the exchange, and back with a "Session expired" line on a 401.

const expiredProblem = {
  type: 'urn:cold-reserve:problem:signature_expired',
  title: 'Unauthorized',
  status: 401,
  detail: 'The demo session expired.',
  instance: 'urn:uuid:00000000-0000-4000-8000-000000000000',
  code: 'signature_expired',
};

test('remote mode asks for the demo code first: 48 px, hidden, never autocompleted, show/hide', async ({ page }) => {
  await page.goto('/?agent=remote');
  const field = page.getByLabel('Demo code');
  await expect(field).toBeVisible();
  await expect(page.getByLabel('Ask a question')).toHaveCount(0);
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toHaveAttribute('autocomplete', 'off');
  expect((await field.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(48);
  await page.getByRole('button', { name: 'Show code' }).click();
  await expect(field).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide code' }).click();
  await expect(field).toHaveAttribute('type', 'password');
});

test('the code goes to sim-api once, then only the token travels; the field comes back empty', async ({ page }) => {
  let sessionBody: unknown = null;
  let turnAuth: string | null = null;
  await page.route('**/sim-api/v1/session', (route) => {
    sessionBody = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: DEMO_TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) });
  });
  await page.route('**/sim-api/v1/turns', (route) => {
    turnAuth = route.request().headers()['authorization'] ?? null;
    return route.fulfill({ status: 401, contentType: 'application/problem+json', body: JSON.stringify(expiredProblem) });
  });
  await page.goto('/?agent=remote');
  await page.getByLabel('Demo code').fill(DEMO_CODE);
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();

  expect(sessionBody).toEqual({ code: DEMO_CODE });
  await expect.poll(() => turnAuth).toBe(`Bearer ${DEMO_TOKEN}`);
  // 401 signature_expired: the token is forgotten and the gate is back, empty, with the expiry line.
  await expect(page.getByRole('status').filter({ hasText: 'Session expired: enter the demo code again.' })).toBeVisible();
  await expect(page.getByLabel('Demo code')).toHaveValue('');
  // Only the gate explains it: no generic "something went wrong" for the turn (review of #140).
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByText("I can't answer right now")).toHaveCount(0);
});

test('a wrong code is refused with a calm line and an empty field', async ({ page }) => {
  await page.route('**/sim-api/v1/session', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({ ...expiredProblem, type: 'urn:cold-reserve:problem:invalid_demo_code', code: 'invalid_demo_code', detail: 'That demo code is not valid.' }),
    }),
  );
  await page.goto('/?agent=remote');
  await page.getByLabel('Demo code').fill('not-the-demo-code');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('alert')).toHaveText("That demo code doesn't work. Check it and try again.");
  await expect(page.getByLabel('Demo code')).toHaveValue('');
});

for (const theme of ['dark', 'light'] as const) {
  test(`the gate fits a 375 px phone in the ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/?agent=remote');
    if (theme === 'light') await page.getByRole('button', { name: 'Light theme' }).click();
    await expect(page.getByLabel('Demo code')).toBeVisible();
    // Evaluated in the browser (the Node tsconfig has no DOM types).
    const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('after the code, the question field works as before', async ({ page }) => {
  await openRemote(page);
  // A valid code moves the focus to the question (review of #140).
  await expect(page.getByLabel('Ask a question')).toBeFocused();
  await expect(page.getByLabel('Demo code')).toHaveCount(0);
});
