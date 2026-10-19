import type { Locator, Page } from '@playwright/test';
import { CATALOGS, type Locale } from '../packages/i18n/src/index.js';

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

/** The person's own settings (language, safe room, temperatures and limits, units): "Settings" opens them. */
export const settingsButton = (root: Root, locale: Locale = 'en-US'): Locator => root.getByRole('button', { name: CATALOGS[locale]['settings.open'], exact: true });
export const userSettings = (page: Page, locale: Locale = 'en-US'): Locator => page.getByRole('dialog', { name: CATALOGS[locale]['settings.open'] });
export async function openUserSettings(page: Page, locale: Locale = 'en-US'): Promise<Locator> {
  await settingsButton(page, locale).click();
  return userSettings(page, locale);
}

/**
 * The screen's menu (#432 S6), top left like the real Echo Show's: its list holds "Show my home" (the settings join it
 * with S5). `homeButton` opens the menu if it is closed and returns the button ("Show my home" or "Hide my home").
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

/** Reads Ana's phone as a person does where it is a sheet (a phone): opens it, reads, closes it again (Escape). */
export async function readPhone(page: Page, read: () => Promise<void>): Promise<void> {
  const sheet = !(await phoneRegion(page).isVisible());
  await openPhone(page);
  await read();
  if (sheet) await page.keyboard.press('Escape');
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
