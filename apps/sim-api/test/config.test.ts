import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_TIMEOUT_MS, loadSimApiConfig } from '../src/config.js';

const CODE = 'judges-demo-code-2026';
const HASH = createHash('sha256').update(CODE).digest('hex');
const KEY = Buffer.alloc(32, 7).toString('base64url');
const ENV = { SIM_DEMO_CODES: `judges:${HASH}`, SIM_TOKEN_KEYS: `k1:${KEY}`, SIM_ALLOWED_ORIGINS: 'http://127.0.0.1:5400' };

describe('loadSimApiConfig (only hashes of codes and key ids reach logs; values come from .env or SSM)', () => {
  it('reads codes by hash, signing keys by kid, and the defaults of the plan', () => {
    const result = loadSimApiConfig(ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.demoCodes.get(HASH)).toBe('judges');
    expect(result.value.keys.map((k) => k.kid)).toEqual(['k1']);
    expect(result.value).toMatchObject({
      tokenTtlS: 3600,
      skewS: 30,
      allowedOrigins: ['http://127.0.0.1:5400'],
      demoEnabled: true,
      limits: { turnsPerCodePerDay: 20, turnsGlobalPerDay: 30, toolCallsPerCodePerDay: 20, readCallsPerCodePerDay: 200, readCallsGlobalPerDay: 2000, demoCallsPerCodePerDay: 150, codeAttemptsPerIpPerHour: 10, speechCharsPerCodePerDay: 6000, speechCharsGlobalPerDay: 30_000, phoneReadsPerSessionPerMinute: 20, phoneReadsPerCodePerMinute: 120, logLinesPerSessionPerMinute: 30, logLinesGlobalPerMinute: 600 },
      speech: { enabled: false, engine: 'neural', voice: 'Joanna' },
    });
  });

  it('reads the Polly settings (F8d, #25): off unless switched on, one voice from config, true or false only', () => {
    expect(loadSimApiConfig({ ...ENV, SIM_SPEECH_ENABLED: 'true', SIM_SPEECH_VOICE: 'Matthew' })).toMatchObject({ ok: true, value: { speech: { enabled: true, engine: 'neural', voice: 'Matthew' } } });
    for (const bad of [{ SIM_SPEECH_ENABLED: 'yes' }, { SIM_SPEECH_VOICE: 'joanna; drop' }, { SIM_SPEECH_ENGINE: 'premium' }, { SIM_LIMIT_SPEECH_CHARS_PER_CODE: '0' }]) {
      expect(loadSimApiConfig({ ...ENV, ...bad })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    }
  });

  it('reads both phone caps (#294), each a whole number from 1 to 600', () => {
    expect(loadSimApiConfig({ ...ENV, SIM_LIMIT_PHONE_READS_PER_SESSION_PER_MINUTE: '12', SIM_LIMIT_PHONE_READS_PER_CODE_PER_MINUTE: '60' })).toMatchObject({ ok: true, value: { limits: { phoneReadsPerSessionPerMinute: 12, phoneReadsPerCodePerMinute: 60 } } });
    for (const bad of [{ SIM_LIMIT_PHONE_READS_PER_SESSION_PER_MINUTE: '0' }, { SIM_LIMIT_PHONE_READS_PER_CODE_PER_MINUTE: '601' }]) {
      expect(loadSimApiConfig({ ...ENV, ...bad })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    }
  });

  it('takes only true or false for the kill switch (unset = on): a typo is invalid_config, never a silently open demo', () => {
    expect(loadSimApiConfig({ ...ENV, SIM_DEMO_ENABLED: 'true' })).toMatchObject({ ok: true, value: { demoEnabled: true } });
    for (const value of ['maybe', 'off', '0']) expect(loadSimApiConfig({ ...ENV, SIM_DEMO_ENABLED: value })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('takes no allowed origin behind the CloudFront proxy: same-origin calls carry none, any other Origin is refused (#244)', () => {
    expect(loadSimApiConfig({ ...ENV, SIM_ALLOWED_ORIGINS: '' })).toMatchObject({ ok: true, value: { allowedOrigins: [] } });
    expect(loadSimApiConfig({ ...ENV, SIM_ALLOWED_ORIGINS: undefined })).toMatchObject({ ok: true, value: { allowedOrigins: [] } });
  });

  it('reads the origin secret of the CloudFront distribution, and the previous one during a rotation (#243)', () => {
    const current = 'c'.repeat(32);
    const previous = 'p'.repeat(32);
    expect(loadSimApiConfig(ENV)).toMatchObject({ ok: true, value: { originSecrets: [] } });
    expect(loadSimApiConfig({ ...ENV, SIM_ORIGIN_SECRET: current })).toMatchObject({ ok: true, value: { originSecrets: [current] } });
    expect(loadSimApiConfig({ ...ENV, SIM_ORIGIN_SECRET: current, SIM_ORIGIN_SECRET_PREVIOUS: previous })).toMatchObject({ ok: true, value: { originSecrets: [current, previous] } });
    // `none`: the previous parameter exists but holds no secret (outside a rotation).
    expect(loadSimApiConfig({ ...ENV, SIM_ORIGIN_SECRET: current, SIM_ORIGIN_SECRET_PREVIOUS: 'none' })).toMatchObject({ ok: true, value: { originSecrets: [current] } });
    const short = loadSimApiConfig({ ...ENV, SIM_ORIGIN_SECRET: 'tiny-origin-value' }); // gitleaks:allow (a dummy too short to be valid)
    expect(short).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(JSON.stringify(short)).not.toContain('tiny-origin-value');
  });

  it('switches the demo off with SIM_DEMO_ENABLED=false (kill switch)', () => {
    expect(loadSimApiConfig({ ...ENV, SIM_DEMO_ENABLED: 'false' })).toMatchObject({ ok: true, value: { demoEnabled: false } });
  });

  it.each([
    ['no demo codes', { ...ENV, SIM_DEMO_CODES: '' }],
    ['a code that is not a sha256 hash', { ...ENV, SIM_DEMO_CODES: `judges:${CODE}` }],
    ['no signing key', { ...ENV, SIM_TOKEN_KEYS: '' }],
    ['a key shorter than 32 bytes', { ...ENV, SIM_TOKEN_KEYS: `k1:${Buffer.alloc(16).toString('base64url')}` }],
    ['a key without a kid', { ...ENV, SIM_TOKEN_KEYS: KEY }],
    ['two keys with the same kid', { ...ENV, SIM_TOKEN_KEYS: `k1:${KEY},k1:${KEY}` }],
    ['an allowed origin that is not a URL', { ...ENV, SIM_ALLOWED_ORIGINS: 'sim.example' }],
    ['a non-numeric limit', { ...ENV, SIM_LIMIT_TURNS_PER_CODE: 'many' }],
    ['a token lifetime over one hour', { ...ENV, SIM_TOKEN_TTL_S: '7200' }],
  ])('fails with invalid_config on %s, without echoing secrets', (_name, env) => {
    const result = loadSimApiConfig(env);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe('the default wait for the agent (#270)', () => {
  it('is the agent deadline plus its margin from the timing table in infra/cdk.json', () => {
    const cdk = JSON.parse(readFileSync(new URL('../../../infra/cdk.json', import.meta.url), 'utf8')) as { context: Record<string, { agentDeadlineMs?: number; agentMarginMs?: number }> };
    const t = cdk.context['cold-reserve:turnTiming'];
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe((t?.agentDeadlineMs ?? 0) + (t?.agentMarginMs ?? 0));
  });
});
