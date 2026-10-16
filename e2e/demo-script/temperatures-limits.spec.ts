import { expect, test } from '../no-network.js';

// #402: one "Temperatures and limits" section in the settings: the safe room, the comfort temperature, the safe room
// maximum (stricter only), the night health limits with their sources, the units. Scripted mode, no network.

test('open the settings, change the comfort, refuse a looser maximum, choose another safe room, switch to °F', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByRole('button', { name: /SCENARIO/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Demo settings' });
  const section = drawer.getByRole('region', { name: 'Temperatures and limits' });
  await expect(section).toBeVisible();

  // The night health limits come with their sources.
  await expect(section).toContainText('Adult, 22:00–07:00: at most 26 °C');
  await expect(section).toContainText('With an older person: at most 24 °C');
  await expect(section).toContainText('CIBSE TM59');

  // The comfort temperature moves by half a degree in the draft.
  const comfort = section.getByRole('group', { name: 'Comfort temperature' });
  await expect(comfort.locator('output')).toHaveText('25 °C');
  await section.getByRole('button', { name: 'Lower: Comfort temperature' }).click();
  await expect(comfort.locator('output')).toHaveText('24.5 °C');

  // A looser heat cap is refused, in words, and nothing changes.
  const cap = section.getByRole('group', { name: 'Cap with an older person' });
  const shown = await cap.locator('output').innerText();
  await section.getByRole('button', { name: 'Raise: Cap with an older person' }).click();
  await expect(section.getByTestId('limit-refusal')).toContainText('can only be made stricter');
  await expect(cap.locator('output')).toHaveText(shown);

  // Another safe room: one choice, in the same draft.
  const rooms = section.getByRole('radiogroup', { name: 'Safe room' });
  const other = rooms.getByRole('radio', { name: 'Living' });
  await other.check();
  await expect(other).toBeChecked();
  await expect(rooms.getByRole('radio', { name: 'Bedroom 1' })).not.toBeChecked();

  // One Save writes the draft; afterwards there is nothing left to save and the values stay.
  const save = section.getByRole('button', { name: 'Save' });
  await expect(save).toHaveAttribute('aria-disabled', 'false');
  await save.click();
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(comfort.locator('output')).toHaveText('24.5 °C');
  await expect(other).toBeChecked();

  // The units: everything in the section follows.
  await section.getByRole('radiogroup', { name: 'Temperature units' }).getByText('°F').click();
  await expect(comfort.locator('output')).toHaveText('76.1 °F');
  await expect(section).toContainText('at most 78.8 °F');
});
