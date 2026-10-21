import type { Locator, Page } from '@playwright/test';
import { CATALOGS, PRODUCT_NAME, type Locale } from '../packages/i18n/src/index.js';

// How the specs reach the screen (separation of the device layout, #432). The device look is a layout that another can
// replace, so a spec never names a layout's own classes. It reads the screen through the test ids every layout writes:
// `slot-<name>` for the named places, `screen-viewport` for the screen's scroll area (it never scrolls),
// `answer-caption` for an answer's words, `welcome-hint` for the first screen. The judges' demo controls and the
// person's own settings are reached through this one file, so moving them changes this file only, not every spec.

type Root = Page | Locator;

/** The named places of the screen that every layout fills (background = the sky, head, content, actions). */
export type SlotName = 'background' | 'head' | 'content' | 'actions';
export const slot = (root: Root, name: SlotName): Locator => root.getByTestId(`slot-${name}`);

/**
 * The judges' demo controls (#432): a column beside the Echo on a wide screen, a sheet behind the "Demo controls"
 * button of the top bar below it. `demoControls` is the panel in either form; `openDemoControls` shows it if it is a
 * closed sheet and returns it.
 */
export const demoControls = (page: Page): Locator => page.getByTestId('demo-controls');
export const demoControlsButton = (root: Root, locale: Locale = 'en-US'): Locator => root.getByRole('button', { name: new RegExp(`^${CATALOGS[locale]['demoControls.open']} · `) });
export async function openDemoControls(page: Page, locale: Locale = 'en-US'): Promise<Locator> {
  const panel = demoControls(page);
  if (!(await panel.isVisible())) await demoControlsButton(page, locale).click();
  return panel;
}
/** What the demo plays now ("Reference home (Italy) · Heat wave"): on the button below the wide layout, in the panel on it. */
export const demoControlsSummary = (page: Page): Locator => page.getByTestId('demo-controls-summary').filter({ visible: true }).first();

/**
 * The person's own settings (#432 S5: who we protect, language, safe room, temperatures and limits, units): a page of
 * the Echo's screen, "Settings" in the screen's menu. `userSettings` is the page on the Echo (Ana's phone has its own,
 * `openPhoneSettings`); `openUserSettings` opens it from the menu unless it is open already and returns it.
 */
// Titled for Leo's home, or for your home when no one at risk is at home (owner, 21 Oct): either is the page.
const settingsTitle = (locale: Locale): RegExp => {
  const titles = (['settings.page.title', 'settings.page.titleHome'] as const).map((key) => CATALOGS[locale][key].replace('{product}', PRODUCT_NAME));
  return new RegExp(`^(?:${titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
};
export const settingsButton = (root: Root, locale: Locale = 'en-US'): Locator => root.getByRole('button', { name: CATALOGS[locale]['settings.open'], exact: true });
export const userSettings = (page: Page, locale: Locale = 'en-US'): Locator => slot(page, 'content').getByRole('region', { name: settingsTitle(locale) });
export async function openUserSettings(page: Page, locale: Locale = 'en-US'): Promise<Locator> {
  const settings = userSettings(page, locale);
  if (await settings.isVisible()) return settings;
  await menuButton(page, locale).click();
  await settingsButton(page, locale).click();
  return settings;
}

/**
 * The screen's menu (#432 S6), top left like the real Echo Show's: its list holds "Show my home" and (S5) "Settings".
 * `homeButton` opens the menu if it is closed and returns the button ("Show my home" or "Hide my home").
 */
export const menuButton = (root: Root, locale: Locale = 'en-US'): Locator => root.getByRole('button', { name: CATALOGS[locale]['screen.menu'], exact: true });
export async function homeButton(page: Page, locale: Locale = 'en-US'): Promise<Locator> {
  const button = page.getByRole('button', { name: new RegExp(`^(${CATALOGS[locale]['home.show']}|${CATALOGS[locale]['home.hide']})$`) });
  if (!(await button.isVisible())) await menuButton(page, locale).click();
  return button;
}
/**
 * Ana's phone (#432, owner J = a): beside the Echo where it fits, else a sheet behind the "Ana's phone" button of the
 * top bar. `openPhone` shows it if it is not in view and returns it.
 */
export const phoneRegion = (page: Page, locale: Locale = 'en-US'): Locator => page.getByRole('region', { name: CATALOGS[locale]['phone.title'] });
export async function openPhone(page: Page, locale: Locale = 'en-US'): Promise<Locator> {
  const phone = phoneRegion(page, locale);
  if (!(await phone.isVisible())) await page.getByRole('button', { name: new RegExp(`^${CATALOGS[locale]['phone.open']}`) }).click();
  return phone;
}
/** #432 S5: Leo's home settings on Ana's phone, the same page as the Echo's: "Manage Leo's home settings" opens it. */
export async function openPhoneSettings(page: Page, locale: Locale = 'en-US'): Promise<Locator> {
  const phone = await openPhone(page, locale);
  const settings = phone.getByRole('region', { name: settingsTitle(locale) });
  if (!(await settings.isVisible())) await phone.getByRole('button', { name: CATALOGS[locale]['phone.manageSettings'] }).click();
  return settings;
}

/** Reads Ana's phone as a person does where it is a sheet (a phone): opens it, reads, closes it again (Escape). */
export async function readPhone(page: Page, read: () => Promise<void>): Promise<void> {
  const sheet = !(await phoneRegion(page).isVisible());
  await openPhone(page);
  // Closed even when the read fails (a step marked as a known bug fails inside it): the sheet must not stay over the
  // Echo and break the next step.
  try {
    await read();
  } finally {
    if (sheet) await page.keyboard.press('Escape');
  }
}

/**
 * One card per answer (owner, 19 Oct, B): the answer opens on its main card; another one of its cards comes on screen
 * when its words are typed ("Show the plan"). Typed only when that card is not on screen already (otherwise the words
 * would be a question to the assistant). Returns the card's frame.
 */
export async function showCard(page: Page, words: string, frameTitle: string) {
  const frame = page.locator(`iframe[title="${frameTitle}"]`);
  if (!(await frame.isVisible())) {
    await page.getByLabel(CATALOGS['en-US']['chat.label']).or(page.getByLabel(CATALOGS['it-IT']['chat.label'])).fill(words);
    await page.getByRole('button', { name: /^(Ask|Chiedi)$/ }).click();
  }
  return page.frameLocator(`iframe[title="${frameTitle}"]`);
}

/** "Show my home" from the menu. */
export async function showMyHome(page: Page, locale: Locale = 'en-US'): Promise<void> {
  await (await homeButton(page, locale)).click();
}
