import { expect, test } from '../no-network.js';
import { openRemote, routeSandboxTools } from '../remote-session.js';

// A tap that takes time (15 Oct, found on a phone): the clock button shows it is working (busy, off, a turning mark) and
// the page waits for the home's answer, then shows the new time. sim-api is intercepted; the move answers after 5 s.

test('The clock button waits 5 s for the home, shows it is busy, then shows the new time', async ({ page }) => {
  await openRemote(page);
  let moved = false;
  await routeSandboxTools(page);
  await page.route('**/sim-api/v1/tools/call', async (route) => {
    const { name } = route.request().postDataJSON() as { name: string };
    const answer = (structuredContent: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], structuredContent }) });
    if (name === 'advance_clock') {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      moved = true;
      return answer({ now: '2026-07-15T19:00:00+02:00', settingsVersion: 2 });
    }
    if (name === 'get_milestones' && moved) {
      return answer({ now: '2026-07-15T19:00:00+02:00', day: { from: '2026-07-15T14:00:00+02:00', to: '2026-07-16T14:00:00+02:00' }, milestones: [] });
    }
    return route.fallback();
  });
  await page.reload();
  await page.getByLabel('Demo code').fill('e2e-demo-code-0001');
  await page.getByRole('button', { name: 'Start' }).click();
  const clock = page.getByRole('group', { name: 'Simulated time' });
  await expect(clock.locator('time')).toHaveText('14:00');
  const button = clock.getByRole('button', { name: /Go to 19:00/ });
  await button.click();
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(button).toBeDisabled();
  await expect(clock.getByTestId('spinner')).toBeVisible();
  await expect(clock.getByRole('status')).toHaveText('Moving the clock…');
  await expect(clock.locator('time')).toHaveText('19:00', { timeout: 12_000 });
  await expect(clock.getByTestId('spinner')).toHaveCount(0);
});
