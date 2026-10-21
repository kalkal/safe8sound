import { ACTION_CONTEXT_KEY, DEMO_CONTEXT_KEY, PLACE_CONTEXT_KEY, UNITS_CONTEXT_KEY } from '@cold-reserve/ui-cards';
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
      [ACTION_CONTEXT_KEY]: { phase: 'ready' },
    });
    // #263: the cards speak the page's language, through the standard hostContext.locale.
    expect(hostContextFor({ ...base, locale: 'it-IT', demo: false })).toMatchObject({ locale: 'it-IT' });
  });

  it('no scrolling on the Echo screen (owner, 10 Oct): inline, the height the card has, as MCP Apps containerDimensions', () => {
    const base = { theme: 'dark' as const, timeZone: 'Europe/Rome', fullscreen: false, locale: 'en-US' as const, demo: false };
    expect(hostContextFor({ ...base, maxHeight: 221 })).toMatchObject({ containerDimensions: { maxHeight: 221 } });
    expect(hostContextFor(base)).not.toHaveProperty('containerDimensions');
  });

  it('°F everywhere (owner decision, 9 Oct): always tells the card the chosen unit, so a switch back to °C reaches it too', () => {
    const base = { theme: 'dark' as const, timeZone: 'Europe/Rome', fullscreen: false, locale: 'en-US' as const, demo: false };
    expect(hostContextFor({ ...base, units: 'F' })).toMatchObject({ [UNITS_CONTEXT_KEY]: 'F' });
    expect(hostContextFor({ ...base, units: 'C' })).toMatchObject({ [UNITS_CONTEXT_KEY]: 'C' });
  });
});

describe('where the card action stands, in one message (busy, applied, expired)', () => {
  it('always says it, so a card shown again knows its plan is applied', () => {
    const base = { theme: 'dark' as const, timeZone: 'Europe/Rome', fullscreen: false, locale: 'en-US' as const, demo: false };
    expect(hostContextFor({ ...base, action: { phase: 'applied', at: '2026-07-15T14:05:00+02:00' } })).toMatchObject({ [ACTION_CONTEXT_KEY]: { phase: 'applied', at: '2026-07-15T14:05:00+02:00' } });
    expect(hostContextFor(base)).toMatchObject({ [ACTION_CONTEXT_KEY]: { phase: 'ready' } });
  });
});

describe('#376: the place of the home, for the number to call on a last resort', () => {
  const base = { theme: 'dark' as const, timeZone: 'Europe/Rome', fullscreen: false, locale: 'en-US' as const, demo: false };

  it('names the place the judge chose, and nothing when the page knows none (never a default number)', () => {
    expect(hostContextFor({ ...base, place: 'houston' })).toMatchObject({ [PLACE_CONTEXT_KEY]: 'houston' });
    expect(hostContextFor({ ...base, place: 'turin' })).toMatchObject({ [PLACE_CONTEXT_KEY]: 'turin' });
    expect(hostContextFor(base)).not.toHaveProperty(PLACE_CONTEXT_KEY);
  });
});
