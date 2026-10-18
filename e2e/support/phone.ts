import type { Page } from '@playwright/test';

// Ana's phone reads its inbox on a poll (VITE_PHONE_POLL_MS, 5 s, plus the read itself): a check that "Ana hears
// nothing" or "Ana heard it" waits for real reads of the inbox, never for a fixed time.

const INBOX = /\/v1\/phone\/inbox$|\/phone\/inbox$/;

/** Waits until the page has read Ana's inbox `times` more times. */
export async function phoneReads(page: Page, times = 2): Promise<void> {
  for (let i = 0; i < times; i++) await page.waitForResponse((res) => INBOX.test(new URL(res.url()).pathname), { timeout: 20_000 });
}
