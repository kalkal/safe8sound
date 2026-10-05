import { expect, test } from '../no-network.js';
import { expectVoiceMatchesCards } from '../voice-screen.js';

// Video scene 2a (#203, #227): an ordinary sunny afternoon. The plan card says where the solar surplus went instead
// of the grid: the window, the kWh kept at home, the rooms in order by name. It reads without narration, the voice
// says the same numbers, and it fits a 375 px phone. ScriptedAgent only.

for (const width of [375, 1280]) {
  test(`scene 2a at ${String(width)} px: where the sun went, in the card and in the voice`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page.getByLabel('Ask a question').fill('Where did the solar surplus go today?');
    await page.getByRole('button', { name: 'Ask' }).click();

    const card = page.frameLocator('iframe[title="Plan card"]');
    const surplus = card.getByRole('region', { name: 'Solar surplus, 12:00 to 16:00' });
    await expect(surplus.getByTestId('surplus-kept')).toHaveText('2.4 kWh');
    await expect(surplus.getByRole('listitem')).toHaveText([/^Bedroom 1Safe room/, /^LivingOccupied/]);
    await expect(card.getByTestId('origin-badge').first()).toContainText('SIMULATED');
    await expect(page.getByTestId('answer').last()).toContainText('2.4 kWh between 12:00 and 16:00');
    await expectVoiceMatchesCards(page, ['Plan card']);
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(width);
  });
}
