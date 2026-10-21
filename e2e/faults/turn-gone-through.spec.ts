import { expect, test } from '../no-network.js';
import { openRemote } from '../remote-session.js';

// #477 (dev site, 20 Oct, 1904×870): a turn ended in HTTP 503 after its tools ran; the screen said "That took too long"
// while the storm was prepared and Ana was told. After a failed turn the page reads the phone (and the home) again, never
// the model, and says what it finds: here Ana's new message, with its home time. Try again still works and adds nothing
// twice. With nothing new, the words of today. Outcomes O9 (never contradicts) and O14 (errors say what to do).

const prepared = {
  at: '2026-07-15T12:00:00-05:00',
  role: 'daughter',
  channel: 'in_app',
  transition: 'storm_prepared',
  text: "Storm expected: the home is ready. Leo's room is at 78.8 °F; if the power goes out, the battery keeps it safe at least until 12:00 tomorrow.",
};
const timedOut = { type: 'urn:cold-reserve:problem:agent_timeout', title: 'Service Unavailable', status: 503, detail: 'The assistant took too long.', instance: 'urn:uuid:00000000-0000-4000-8000-000000000002', code: 'agent_timeout' };

for (const told of [true, false]) {
  test(`a turn that times out after its tools ran ${told ? 'says Ana was told' : 'keeps the words of today when nothing changed'}`, async ({ page }) => {
    test.setTimeout(40_000);
    let turnRan = false;
    let turns = 0;
    // Ana's inbox is intercepted: it holds the storm-prepared message once the first turn has "run" (the real tools are
    // the site chain's; here only what the page does with the reads is checked).
    await page.route('**/sim-api/v1/phone/inbox', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ messages: told && turnRan ? [prepared] : [] }) }),
    );
    await page.route('**/sim-api/v1/turns', (route) => {
      turns += 1;
      // The first turn's tools ran (the storm is prepared, Ana told) and then the answer timed out.
      if (turns === 1) {
        turnRan = true;
        return route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify(timedOut) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: "Leo's room is ready for the storm." }) });
    });
    await openRemote(page);
    // The page logs what its reads after the failure found, with the failed turn's id (review of #491).
    const finding = page.waitForEvent('console', { predicate: (m) => m.text().includes('turn_after_failure'), timeout: 15_000 });
    await page.getByLabel('Ask a question').fill("A storm is coming tonight. Get Leo's room ready.");
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    const failure = page.getByRole('alert');
    if (told) {
      await expect(failure).toContainText('That took too long, but it may have gone through: Ana was told at 12:00.', { timeout: 10_000 });
      expect((await finding).text()).toContain('"finding":"told"');
      await expect(page.getByRole('region', { name: "Your daughter's phone (simulated)" }).getByRole('article')).toHaveCount(1);
    } else {
      await expect(failure).toContainText('That took too long. Please try again.');
      // Once the reads are done (the log says what they found), the words stay those of today.
      expect((await finding).text()).toContain('"finding":"nothing"');
      await expect(failure).toContainText('That took too long. Please try again.');
    }

    // Try again still works, and nothing is shown twice.
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('answer').last()).toContainText("Leo's room is ready for the storm.");
    if (told) await expect(page.getByRole('region', { name: "Your daughter's phone (simulated)" }).getByRole('article')).toHaveCount(1);
    expect(turns).toBe(2);
  });
}
