import type { Locator, Page } from '@playwright/test';
import { CATALOGS, type Locale } from '../packages/i18n/src/index.js';

// How the specs reach the screen (separation of the device layout, step S0). The device look is a layout that
// another can replace, so a spec never names a layout's own classes. It reads the screen through the test ids every
// layout writes: `slot-<name>` for the named places, `screen-viewport` for the screen's scroll area (it never
// scrolls), `answer-caption` for an answer's words, `welcome-hint` for the first screen. The judges' demo controls
// are reached through this one file, so moving them changes this file only, not every spec.

type Root = Page | Locator;

/** The named places of the screen that every layout fills (background = the sky, head, content, actions). */
export type SlotName = 'background' | 'head' | 'content' | 'actions';
export const slot = (root: Root, name: SlotName): Locator => root.getByTestId(`slot-${name}`);

/** The judges' demo controls: the button that opens them, and the dialog, by its title in the page's language. */
export const demoControlsButton = (root: Root): Locator => root.getByRole('button', { name: /SCENARIO/ });
export const demoControls = (page: Page, locale: Locale = 'en-US'): Locator =>
  page.getByRole('dialog', { name: CATALOGS[locale]['settings.title'] });
