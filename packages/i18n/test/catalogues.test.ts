import { LocaleSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { CATALOGS, LOCALES, format } from '../src/index.js';

// #263: English stays the default; Italian is the second language. Both catalogues have the same keys, and each
// translation uses exactly the placeholders of the English text, so no value is ever lost or invented.

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('catalogues', () => {
  it('offers English and Italian', () => {
    expect(LOCALES).toEqual(['en-US', 'it-IT']);
    // The same languages the turn wire accepts.
    expect(LOCALES).toEqual(LocaleSchema.options);
  });

  it('every key of the English catalogue is in the Italian one, and no other', () => {
    expect(Object.keys(CATALOGS['it-IT']).sort()).toEqual(Object.keys(CATALOGS['en-US']).sort());
  });

  it('each Italian text has the same placeholders as the English one', () => {
    const en: Record<string, string> = CATALOGS['en-US'];
    const it: Record<string, string> = CATALOGS['it-IT'];
    const differ = Object.keys(en).filter((k) => JSON.stringify(placeholders(en[k] ?? '')) !== JSON.stringify(placeholders(it[k] ?? '')));
    expect(differ).toEqual([]);
  });

  it('#284: phrases that ask for a spoken command stay English while recognition and the agent are English', () => {
    for (const key of ['prefs.voiceHint', 'card.noActions'] as const) expect(CATALOGS['it-IT'][key]).toBe(CATALOGS['en-US'][key]);
  });

  it('formats in Italian with the same values', () => {
    expect(format('it-IT', 'plan.validUntil', { time: '14:10' })).toEqual({ ok: true, value: 'Piano valido fino alle 14:10.' });
  });
});
