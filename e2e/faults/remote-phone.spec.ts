import { expect, test } from '../no-network.js';
import { DEMO_TOKEN, openRemote } from '../remote-session.js';

// #267 (panel part): in remote mode the family phone (Ana's phone) reads the visitor's sandbox inbox from sim-api,
// GET /v1/phone/inbox with the demo session token; it keeps the last list when a read fails, and waits retryAfterMs after a 429. sim-api is intercepted
// here; the real route is covered by sim-api's own tests and, once on main, by the site chain.

const storm = {
  at: '2026-07-18T21:40:00+02:00',
  role: 'daughter',
  channel: 'in_app',
  transition: 'storm_started',
  text: "Safe-8-Sound alert for Ana: a storm cut the power at home. Leo's room is at 26.8 °C and the battery keeps it safe until 06:40. No action is needed now.",
};

test('remote mode: the phone panel shows the sandbox inbox, read with the session token, and keeps it on a 429, waiting as asked', async ({ page }) => {
  // Up to ~18 s of waits on the 5 s poll (the first read, the refusal, the quiet 7 s): past the 20 s default (review of #296).
  test.setTimeout(40_000);
  const auth: string[] = [];
  let fail = false;
  await page.route('**/sim-api/v1/phone/inbox', (route) => {
    auth.push(route.request().headers()['authorization'] ?? '');
    // sim-api's per-code cap (#293): 429 with the wait in the body.
    if (fail) return route.fulfill({ status: 429, contentType: 'application/problem+json', body: JSON.stringify({ status: 429, code: 'demo_quota_exceeded', retryAfterMs: 60_000 }) });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ messages: [storm] }) });
  });
  await openRemote(page);

  const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
  // The read on mount comes before the demo code, so it is skipped; the first read is the next poll (5 s).
  await expect(phone.getByRole('article', { name: 'Power outage (storm) at home' })).toContainText('Safe-8-Sound alert for Ana', { timeout: 15_000 });
  expect(auth[0]).toBe(`Bearer ${DEMO_TOKEN}`);
  // The icon of the device, with the dot of a new message.
  await expect(phone.locator('svg[data-device="phone"] circle')).toHaveCount(1);
  // No reply buttons until sim-api has a reply route.
  await expect(phone.getByRole('group', { name: 'Reply' })).toHaveCount(0);

  fail = true;
  const reads = auth.length;
  await expect.poll(() => auth.length, { timeout: 15_000 }).toBeGreaterThan(reads);
  await expect(phone.getByRole('article', { name: 'Power outage (storm) at home' })).toBeVisible();
  // No error loop: nothing is read during the wait sim-api asked for (the poll is 5 s).
  const afterRefusal = auth.length;
  await page.waitForTimeout(7_000);
  expect(auth.length).toBe(afterRefusal);
  await expect(phone.getByRole('article', { name: 'Power outage (storm) at home' })).toBeVisible();
});

test('an expired session on the phone read ends the session once: the code gate is back, no 401 every poll (review of #296)', async ({ page }) => {
  test.setTimeout(40_000);
  let reads = 0;
  await page.route('**/sim-api/v1/phone/inbox', (route) => {
    reads += 1;
    return route.fulfill({ status: 401, contentType: 'application/problem+json', body: JSON.stringify({ status: 401, code: 'signature_expired' }) });
  });
  await openRemote(page);
  // The first read (the next 5 s poll) is refused: the token is forgotten and the gate says why, as for a turn.
  await expect(page.getByRole('status').filter({ hasText: 'Session expired: enter the demo code again.' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Demo code')).toHaveValue('');
  const refused = reads;
  await page.waitForTimeout(7_000);
  expect(reads).toBe(refused);
});
