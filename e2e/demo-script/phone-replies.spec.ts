import { expect, test } from '../no-network.js';

// Queue item 3 (#24): during the storm the daughter's phone answers by touch, "I'm on my way" or "Check status".
// One tap, one reply; the phone says it was sent. ScriptedAgent and the scripted phone only.

test('the family phone answers during the storm, by touch, on a 375 px phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
  // Nothing to answer before a message arrives.
  await expect(phone.getByRole('button', { name: "I'm on my way" })).toHaveCount(0);

  await page.getByLabel('Ask a question').fill("The power's out");
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(phone.getByRole('article', { name: 'Power outage (storm) at home' })).toBeVisible();

  const replies = phone.getByRole('group', { name: 'Reply' });
  await replies.getByRole('button', { name: "I'm on my way" }).click();
  await expect(replies.getByRole('status')).toHaveText("Sent: they know you're on your way.");
  await replies.getByRole('button', { name: 'Check status' }).click();
  await expect(replies.getByRole('status')).toHaveText('Sent: they know you asked.');
  // The targets stay reachable by touch: at least 48 px high.
  const box = await replies.getByRole('button', { name: 'Check status' }).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
});
