import { describe, expect, it } from 'vitest';
import { CATALOGS, LOCALES, PRODUCT_NAME, format } from '../src/index.js';

describe('message catalogs', () => {
  it('ships en-US, the demo language', () => {
    expect(LOCALES).toContain('en-US');
  });

  it('keeps the same keys in every catalog', () => {
    const reference = Object.keys(CATALOGS['en-US']).sort();
    for (const locale of LOCALES) expect(Object.keys(CATALOGS[locale]).sort()).toEqual(reference);
  });
});

describe('format', () => {
  it('fills named placeholders', () => {
    expect(format('en-US', 'level.changed', { level: 'saver', until: '7:00' })).toEqual({
      ok: true,
      value: "I'm switching to saver mode so the safe room stays comfortable until 7:00.",
    });
  });

  it('fills {product} from the single product name, which may still change', () => {
    expect(PRODUCT_NAME).toBe('Cold Reserve');
    expect(format('en-US', 'app.welcome')).toEqual({ ok: true, value: `Welcome to ${PRODUCT_NAME}.` });
  });

  it('never hard-codes the product name inside a catalog string', () => {
    for (const locale of LOCALES) {
      for (const text of Object.values(CATALOGS[locale])) expect(text).not.toContain(PRODUCT_NAME);
    }
  });

  it('returns an error value when a placeholder is missing, never a half-filled sentence', () => {
    expect(format('en-US', 'level.changed', { level: 'saver' })).toMatchObject({ ok: false, error: { missing: ['until'] } });
  });
});
