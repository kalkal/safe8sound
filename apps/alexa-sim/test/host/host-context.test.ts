import { DEMO_CONTEXT_KEY, UNITS_CONTEXT_KEY } from '@cold-reserve/ui-cards';
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
      [UNITS_CONTEXT_KEY]: 'C',
    });
    // #263: the cards speak the page's language, through the standard hostContext.locale.
    expect(hostContextFor({ ...base, locale: 'it-IT', demo: false })).toMatchObject({ locale: 'it-IT' });
  });

  it('°F everywhere (owner decision, 9 Oct): always tells the card the chosen unit, so a switch back to °C reaches it too', () => {
    const base = { theme: 'dark' as const, timeZone: 'Europe/Rome', fullscreen: false, locale: 'en-US' as const, demo: false };
    expect(hostContextFor({ ...base, units: 'F' })).toMatchObject({ [UNITS_CONTEXT_KEY]: 'F' });
    expect(hostContextFor({ ...base, units: 'C' })).toMatchObject({ [UNITS_CONTEXT_KEY]: 'C' });
  });
});
