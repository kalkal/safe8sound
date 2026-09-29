import { describe, expect, it } from 'vitest';
import rawConfig from '../config/guard.json' with { type: 'json' };
import { parseGuardConfig } from '../src/index.js';

describe('guard config', () => {
  it('parses the default file', () => {
    const c = parseGuardConfig(rawConfig);
    expect(c.ok && c.value.reserve).toEqual({ essentialLoadW: 350, capWh: 6000 });
    expect(c.ok && c.value.nightRecovery.thresholdC).toEqual({ standard: 26, elderly: 24 });
  });

  it('reports an invalid config as invalid_config with the field paths', () => {
    const c = parseGuardConfig({ ...rawConfig, projection: { ...rawConfig.projection, stepMinutes: 0 } });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.error.code).toBe('invalid_config');
      expect(c.error.details?.issues?.[0]?.path).toBe('projection.stepMinutes');
    }
  });
});

describe('guard config errors', () => {
  it('says the configuration is not valid and names the field', () => {
    const c = parseGuardConfig({ ...rawConfig, pacing: { ...rawConfig.pacing, maxChangesPerHour: 0 } });
    expect(!c.ok && c.error).toMatchObject({ message: 'The guard configuration is not valid.', details: { issues: [{ path: 'pacing.maxChangesPerHour' }] } });
  });

  it('names the elderly night threshold when it is above the standard one, and accepts them equal (boundary)', () => {
    const c = parseGuardConfig({ ...rawConfig, nightRecovery: { ...rawConfig.nightRecovery, thresholdC: { standard: 26, elderly: 27 } } });
    expect(!c.ok && c.error).toMatchObject({ details: { issues: [{ path: 'nightRecovery.thresholdC.elderly', message: 'The elderly threshold is at most the standard one' }] } });
    expect(parseGuardConfig({ ...rawConfig, nightRecovery: { ...rawConfig.nightRecovery, thresholdC: { standard: 26, elderly: 26 } } }).ok).toBe(true);
  });

  it('keeps the heat-index base at its definition (26.7 °C) and refuses an empty night window', () => {
    expect(parseGuardConfig({ ...rawConfig, nightRecovery: { ...rawConfig.nightRecovery, heatIndexBaseC: 27 } }).ok).toBe(false);
    const same = parseGuardConfig({ ...rawConfig, nightRecovery: { ...rawConfig.nightRecovery, windowStartHour: 7, windowEndHour: 7 } });
    expect(!same.ok && same.error.details?.issues?.[0]?.path).toBe('nightRecovery.windowEndHour');
  });

  it('reports at most 20 issues', () => {
    const c = parseGuardConfig({ schemaVersion: 2 });
    expect(!c.ok && c.error.details?.issues?.length).toBeLessThanOrEqual(20);
    const many = parseGuardConfig({ ...rawConfig, projection: { stepMinutes: 5, baseLoadWByLocalHour: Array.from({ length: 24 }, () => -1) } });
    expect(!many.ok && many.error.details?.issues).toHaveLength(20);
  });
});
