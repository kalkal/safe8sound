import { DEMO_CONTEXT_KEY } from '@cold-reserve/ui-cards';
import { describe, expect, it } from 'vitest';
import { hostContextFor } from '../../src/host/CardFrame.js';

describe('the hostContext a card frame receives', () => {
  it('carries the demo key only in demo mode, so a card marks taps only there', () => {
    const base = { theme: 'dark' as const, timeZone: 'Europe/Rome', fullscreen: false, locale: 'en-US' as const };
    expect(hostContextFor({ ...base, demo: true })).toMatchObject({ [DEMO_CONTEXT_KEY]: true, displayMode: 'inline' });
    expect(hostContextFor({ ...base, demo: false })).not.toHaveProperty(DEMO_CONTEXT_KEY);
    expect(hostContextFor({ ...base, fullscreen: true, demo: false })).toEqual({
      theme: 'dark',
      timeZone: 'Europe/Rome',
      displayMode: 'fullscreen',
      availableDisplayModes: ['inline', 'fullscreen'],
      locale: 'en-US',
    });
    // #263: the cards speak the page's language, through the standard hostContext.locale.
    expect(hostContextFor({ ...base, locale: 'it-IT', demo: false })).toMatchObject({ locale: 'it-IT' });
  });
});
