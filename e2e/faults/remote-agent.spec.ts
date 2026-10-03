import { expect, test } from '../no-network.js';
import { openRemote } from '../remote-session.js';

// Fault injection (error-handling §7): the remote agent fails → scripted answer + a clear notice.
// `?agent=remote` works only on the dev server; sim-api is intercepted at the same origin.
// Remote mode starts with the demo code (#101): openRemote enters it first.

const ask = async (page: import('@playwright/test').Page) => {
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();
};

test('sim-api answers 503 → degraded scripted answer, still marked SIMULATED', async ({ page }) => {
  await page.route('**/sim-api/v1/turns', (route) => route.fulfill({ status: 503, body: 'Service Unavailable' }));
  await openRemote(page);
  await ask(page);

  await expect(page.getByRole('note')).toHaveText("I can't reach the assistant right now, so this is a scripted answer.");
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
  await expect(page.getByTestId('origin-badge')).toHaveText('≈ SIMULATED');
});

test('sim-api sends malformed JSON → degraded scripted answer', async ({ page }) => {
  await page.route('**/sim-api/v1/turns', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"text":' }));
  await openRemote(page);
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
  await openRemote(page);
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
  await openRemote(page);
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
  await openRemote(page);
  await page.getByLabel('Ask a question').fill('Apply the plan');
  await page.getByRole('button', { name: 'Ask' }).click();

  await expect(page.getByRole('note')).toHaveText("I can't reach the assistant right now, so this is a scripted answer.");
  await expect(page.getByTestId('answer')).toContainText("I can't reach the assistant right now, so I can't do that. Nothing was changed.");
  await expect(page.getByText('Plan applied.')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Plan' })).toHaveCount(0);
});

test('sim-api answers 503 → the degraded mode leaves one JSON log line with the turn correlation id (audit L6)', async ({ page }) => {
  let correlationId: string | undefined;
  await page.route('**/sim-api/v1/turns', (route) => {
    correlationId = route.request().headers()['x-correlation-id'];
    return route.fulfill({ status: 503, body: 'Service Unavailable' });
  });
  const lines: unknown[] = [];
  page.on('console', (message) => {
    try {
      const line: unknown = JSON.parse(message.text());
      if (typeof line === 'object' && line !== null && (line as { component?: unknown }).component === 'alexa-sim') lines.push(line);
    } catch {
      // not one of our JSON lines (Vite, React dev messages)
    }
  });
  await openRemote(page);
  await ask(page);

  await expect(page.getByRole('note')).toBeVisible();
  expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
  // The agent's side of the turn: exactly one line. The reply may also be read aloud; where the browser
  // has no voice (headless CI) that leaves its own voice line, for the same turn (see e2e/voice).
  const isVoice = (line: unknown) => typeof (line as { details?: { phase?: unknown } }).details?.phase === 'string';
  expect(lines.filter((line) => !isVoice(line))).toEqual([
    expect.objectContaining({ level: 'warn', code: 'agent_unavailable', category: 'dependency_unavailable', correlationId, details: { degraded: true } }),
  ]);
  for (const line of lines.filter(isVoice)) expect(line).toMatchObject({ correlationId, details: { phase: 'speaking' } });
});

test("remote agent down → \"The power's out\" gets the honest degraded answer, never a fake action or a phone message (#209)", async ({ page }) => {
  await page.route('**/sim-api/v1/turns', (route) => route.fulfill({ status: 503, body: 'Service Unavailable' }));
  await openRemote(page);
  await page.getByLabel('Ask a question').fill("The power's out");
  await page.getByRole('button', { name: 'Ask' }).click();

  await expect(page.getByRole('note')).toHaveText("I can't reach the assistant right now, so this is a scripted answer.");
  const answer = page.getByTestId('answer').last();
  await expect(answer).toContainText('Nothing was changed.');
  await expect(answer).not.toContainText("I've");
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByRole('region', { name: "Your daughter's phone (simulated)" }).getByRole('article')).toHaveCount(0);
});
