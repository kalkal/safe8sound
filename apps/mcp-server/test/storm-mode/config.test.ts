import { describe, expect, it } from 'vitest';
import raw from '../../config/storm-mode.json' with { type: 'json' };
import { parseStormModeConfig } from '../../src/modules/storm-mode/config.js';

describe('storm-mode config', () => {
  it('parses the default file', () => {
    const c = parseStormModeConfig(raw);
    expect(c.ok && c.value).toMatchObject({ capHours: 24, stableGridMinutes: 10, minIntervalMinutes: 60, minReplySeconds: 30, inApp: { maxPerHome: 50 } });
  });

  it.each([
    ['capHours', { capHours: 0 }],
    ['stableGridMinutes', { stableGridMinutes: 1.5 }],
    ['minIntervalMinutes', { minIntervalMinutes: -1 }],
    ['minReplySeconds', { minReplySeconds: 0 }],
    ['minReplySeconds', { minReplySeconds: 3601 }],
  ])('refuses a wrong %s and names the field', (field, change) => {
    const c = parseStormModeConfig({ ...raw, ...change });
    expect(!c.ok && c.error).toMatchObject({ code: 'invalid_config', details: { issues: [{ path: field }] } });
  });

  it("has no EPS load of its own: it is the home profile's (#19), the one number of the simulator, the guard and the safe hours", () => {
    expect(parseStormModeConfig({ ...raw, epsBaseLoadW: 150 }).ok).toBe(false);
  });

  it('refuses unknown fields', () => {
    expect(parseStormModeConfig({ ...raw, surprise: 1 }).ok).toBe(false);
  });
});
