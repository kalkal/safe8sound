import { HomeIdSchema, celsius } from '@cold-reserve/contracts';
import { demoProfile } from '@cold-reserve/source-simulator';
import { describe, expect, it } from 'vitest';
import { defaultPreferencesFor, loadPreferencesConfig, preferencesConfigFile } from '../src/preferences-config.js';

describe('preferences config (hard limits and defaults, validated at startup)', () => {
  it('accepts the shipped config file', () => {
    const result = loadPreferencesConfig(preferencesConfigFile());
    expect(result).toMatchObject({
      ok: true,
      value: {
        limits: { cooling: { maxC: { min: 24, max: 30, default: 27 } }, heating: { minC: { min: 16, max: 22, default: 18 } } },
        comfortC: { cooling: 25, heating: 20 },
        autoStormOnGridLoss: true,
        language: 'en-US',
      },
    });
  });

  it('stops with invalid_config on a broken file, naming the field', () => {
    const broken = { ...(preferencesConfigFile() as Record<string, unknown>), language: 'klingon' };
    expect(loadPreferencesConfig(broken)).toMatchObject({ ok: false, error: { code: 'invalid_config', details: { issues: [{ path: 'language' }] } } });
  });

  it('refuses a default outside its own hard limits', () => {
    const file = structuredClone(preferencesConfigFile()) as { limits: { cooling: { maxC: { default: number } } } };
    file.limits.cooling.maxC.default = 31;
    expect(loadPreferencesConfig(file)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});

describe('defaultPreferencesFor', () => {
  const config = () => {
    const r = loadPreferencesConfig(preferencesConfigFile());
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };

  it('puts the profile safe room first and uses the default thresholds of the config', () => {
    const result = defaultPreferencesFor(config(), demoProfile());
    expect(result.ok && result.value.roomPriority[0]).toBe('bedroom-1');
    expect(result).toMatchObject({
      ok: true,
      value: { safeRoomId: 'bedroom-1', safety: { cooling: { maxC: 27 }, heating: { minC: 18 }, humidity: { minPct: 40, maxPct: 60 } }, familyContacts: [] },
    });
    expect(result.ok && [...result.value.roomPriority].sort()).toEqual(demoProfile().rooms.map((r) => r.id).sort());
  });

  it('fails with invalid_config when the comfort default is outside the safety default', () => {
    const c = config();
    const result = defaultPreferencesFor({ ...c, comfortC: { ...c.comfortC, cooling: celsius(29) } }, demoProfile());
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('fails with invalid_config for a profile without a safe room', () => {
    const profile = { ...demoProfile(), homeId: HomeIdSchema.parse('demo'), rooms: demoProfile().rooms.map((r) => ({ ...r, isSafeRoom: false })) };
    expect(defaultPreferencesFor(config(), profile)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});

describe('the sandbox family contact (#267)', () => {
  const config = () => {
    const loaded = loadPreferencesConfig(preferencesConfigFile());
    if (!loaded.ok) throw new Error(loaded.error.message);
    return loaded.value;
  };

  it('every visitor sandbox starts with one simulated contact: the daughter, Ana, in the app', () => {
    const result = defaultPreferencesFor(config(), demoProfile(), HomeIdSchema.parse('demo#0123456789abcdef'));
    expect(result.ok && result.value.familyContacts).toEqual([{ role: 'daughter', name: 'Ana', channel: 'in_app', handle: 'sandbox-phone' }]);
  });

  it('demo and a home without an id keep no contact: only visitor sandboxes get one', () => {
    expect(defaultPreferencesFor(config(), demoProfile(), HomeIdSchema.parse('demo')).ok && defaultPreferencesFor(config(), demoProfile(), HomeIdSchema.parse('demo'))).toMatchObject({ value: { familyContacts: [] } });
    const none = defaultPreferencesFor(config(), demoProfile());
    expect(none.ok && none.value.familyContacts).toEqual([]);
  });
});
