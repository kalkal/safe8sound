import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('simulator config', () => {
  it('defaults to the ScriptedAgent with explicit timeouts', () => {
    expect(parseConfig({}, '', false)).toEqual({
      ok: true,
      value: {
        agent: 'scripted',
        simApiUrl: undefined,
        agentTimeoutMs: 8_000,
        turnBudgetMs: 10_000,
        homeTimeZone: 'Europe/Rome',
        phone: 'scripted',
        phonePollMs: 5_000,
        voice: {
          speech: 'browser',
          lang: 'en-US',
          voiceName: undefined,
          speakReplies: true,
          listenTimeoutMs: 8_000,
          speakStartTimeoutMs: 2_000,
          speakTimeoutBaseMs: 4_000,
          speakTimeoutPerCharMs: 80,
        },
      },
    });
  });

  it('reads the phone from the real inbox when asked, and refuses an unknown phone source (#24)', () => {
    expect(parseConfig({ VITE_PHONE: 'inbox', VITE_PHONE_POLL_MS: '2000' }, '', false)).toMatchObject({ ok: true, value: { phone: 'inbox', phonePollMs: 2000 } });
    expect(parseConfig({ VITE_PHONE: 'sms' }, '', false)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('reads the remote agent settings from the environment', () => {
    const env = { VITE_AGENT: 'remote', VITE_SIM_API_URL: 'https://sim.example.test', VITE_AGENT_TIMEOUT_MS: '4000', VITE_TURN_BUDGET_MS: '6000' };
    expect(parseConfig(env, '', false)).toMatchObject({ ok: true, value: { agent: 'remote', simApiUrl: 'https://sim.example.test', agentTimeoutMs: 4000 } });
  });

  it('rejects a remote agent without a sim-api URL, and a turn budget shorter than the agent timeout', () => {
    expect(parseConfig({ VITE_AGENT: 'remote' }, '', false)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(parseConfig({ VITE_AGENT_TIMEOUT_MS: '9000', VITE_TURN_BUDGET_MS: '5000' }, '', false)).toMatchObject({ ok: false });
  });

  it('lets ?agent= switch the agent only in dev (fault-injection tests), with a same-origin sim-api', () => {
    expect(parseConfig({}, '?agent=remote', true)).toMatchObject({ ok: true, value: { agent: 'remote', simApiUrl: '/sim-api' } });
    expect(parseConfig({}, '?agent=remote', false)).toMatchObject({ ok: true, value: { agent: 'scripted' } });
  });

  it('reads the home time zone and refuses one that does not exist', () => {
    expect(parseConfig({ VITE_HOME_TIME_ZONE: 'America/New_York' }, '', false)).toMatchObject({ ok: true, value: { homeTimeZone: 'America/New_York' } });
    expect(parseConfig({ VITE_HOME_TIME_ZONE: 'Mars/Olympus' }, '', false)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('reads the voice settings from the environment and refuses nonsense', () => {
    const env = { VITE_VOICE_LANG: 'en-GB', VITE_VOICE_NAME: 'Google UK English Female', VITE_SPEAK_REPLIES: 'false', VITE_LISTEN_TIMEOUT_MS: '5000' };
    expect(parseConfig(env, '', false)).toMatchObject({
      ok: true,
      value: { voice: { lang: 'en-GB', voiceName: 'Google UK English Female', speakReplies: false, listenTimeoutMs: 5000 } },
    });
    expect(parseConfig({ VITE_SPEAK_REPLIES: 'maybe' }, '', false)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(parseConfig({ VITE_LISTEN_TIMEOUT_MS: '0' }, '', false)).toMatchObject({ ok: false });
  });

  it('lets ?voice=fake switch to scripted speech events only in dev (voice E2E tests)', () => {
    expect(parseConfig({}, '?voice=fake', true)).toMatchObject({ ok: true, value: { voice: { speech: 'fake' } } });
    expect(parseConfig({}, '?voice=fake', false)).toMatchObject({ ok: true, value: { voice: { speech: 'browser' } } });
  });
});
