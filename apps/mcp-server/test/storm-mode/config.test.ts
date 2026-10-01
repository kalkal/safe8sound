import { describe, expect, it } from 'vitest';
import raw from '../../config/storm-mode.json' with { type: 'json' };
import { parseStormModeConfig } from '../../src/modules/storm-mode/config.js';

describe('storm-mode config', () => {
  it('parses the default file', () => {
    const c = parseStormModeConfig(raw);
    expect(c.ok && c.value).toMatchObject({ capHours: 24, stableGridMinutes: 10, minIntervalMinutes: 60, inApp: { maxPerHome: 50 } });
  });

  it.each([
    ['capHours', { capHours: 0 }],
    ['stableGridMinutes', { stableGridMinutes: 1.5 }],
    ['minIntervalMinutes', { minIntervalMinutes: -1 }],
    ['epsBaseLoadW', { epsBaseLoadW: 0 }],
    ['occupantGainW', { occupantGainW: 5000 }],
  ])('refuses a wrong %s and names the field', (field, change) => {
    const c = parseStormModeConfig({ ...raw, ...change });
    expect(!c.ok && c.error).toMatchObject({ code: 'invalid_config', details: { issues: [{ path: field }] } });
  });

  it('refuses unknown fields', () => {
    expect(parseStormModeConfig({ ...raw, surprise: 1 }).ok).toBe(false);
  });
});
