import { expect, test } from '../no-network.js';

// #231: after a refused proposal the plan that holds fills the frame, the frame fills the answer, nothing
// overflows and Apply is reachable, at phone and desktop width, in both host themes. ScriptedAgent only.

for (const width of [375, 800]) {
  for (const theme of ['dark', 'light'] as const) {
    test(`the plan that holds fills its frame at ${String(width)} px in the ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      if (theme === 'light') await page.getByRole('button', { name: 'Light theme' }).click();
      await page.getByLabel('Ask a question').fill('Cool every room to 21 degrees now.');
      await page.getByRole('button', { name: 'Ask' }).click();

      const frameElement = page.locator('iframe[title="Plan card"]').last();
      const card = frameElement.contentFrame();
      await expect(card.getByTestId('refused-proposal')).toBeVisible();
      await expect(card.locator('html')).toHaveAttribute('data-card-theme', `pawnio-${theme}`);

      // The frame is as wide as the answer gives it: its host's width, never a narrow column of the Echo's screen (at
      // 800 px Ana's phone stands beside the Echo, owner 19 Oct: the screen is narrower than the window).
      const frameBox = await frameElement.boundingBox();
      const hostBox = await page.locator('.card-frame-host').last().boundingBox();
      const screenBox = await page.getByTestId('echo-screen').boundingBox();
      expect(frameBox?.width).toBe(hostBox?.width);
      expect(frameBox?.width ?? 0).toBeGreaterThan((screenBox?.width ?? width) * 0.75);

      // Inside the frame: the plan card takes the frame's width (less the body margin) and nothing overflows.
      // String expressions: the e2e tsconfig has no DOM types.
      const inner: { view: number; scroll: number; plan: number } = await card.locator('html').evaluate(
        `(() => ({ view: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, plan: document.querySelector('section.card').getBoundingClientRect().width }))()`,
      );
      expect(inner.scroll).toBe(inner.view);
      expect(inner.plan).toBeGreaterThan(inner.view - 32);

      // Apply is inside the frame's box: visible, never cut at the bottom.
      const apply = card.getByRole('button', { name: 'Apply plan' });
      await expect(apply).toBeVisible();
      const applyBox = await apply.boundingBox();
      expect((applyBox?.y ?? 0) + (applyBox?.height ?? 0)).toBeLessThanOrEqual((frameBox?.y ?? 0) + (frameBox?.height ?? 0));
    });
  }
}
