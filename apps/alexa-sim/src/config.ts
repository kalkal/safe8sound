import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

// Every threshold comes from config (Vite env), never from the components.

const DEFAULT_HOME_TIME_ZONE = 'Europe/Rome';

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const ms = z.coerce.number().int().positive();

/** The voice round trip (#25): thresholds measured in spike S5. */
const VoiceConfigSchema = z.strictObject({
  /** `fake`: speech events scripted by the E2E tests (dev only), never the browser's mic or voices. */
  speech: z.enum(['browser', 'fake']),
  lang: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  /** A browser voice by name; otherwise the best one for the language. */
  voiceName: z.string().min(1).optional(),
  speakReplies: z.enum(['true', 'false']).transform((v) => v === 'true'),
  listenTimeoutMs: ms,
  speakStartTimeoutMs: ms,
  /** The studio voice (Polly, F8d #25) gives up after this; the browser voice then reads the reply. */
  studioVoiceTimeoutMs: ms,
  speakTimeoutBaseMs: ms,
  speakTimeoutPerCharMs: ms,
})
  // After the studio voice gives up, the browser voice still needs time to start (≈ 840 ms the first time, spike S5).
  .refine((v) => v.speakStartTimeoutMs >= v.studioVoiceTimeoutMs + 1000, { path: ['speakStartTimeoutMs'], message: 'The speak-start timeout must leave 1 s after the studio voice timeout' });
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

const ConfigSchema = z
  .strictObject({
    agent: z.enum(['scripted', 'remote']),
    simApiUrl: z.string().min(1).optional(),
    agentTimeoutMs: z.coerce.number().int().positive(),
    turnBudgetMs: z.coerce.number().int().positive(),
    /** IANA zone of the home: every time on screen is on the home's clock (sim-api will provide it per home). */
    homeTimeZone: z.string().refine(isTimeZone, { message: 'Unknown IANA time zone' }),
    voice: VoiceConfigSchema,
    /** The family phone (#24): the scripted scene's messages, or the real inbox through the dev proxy. */
    phone: z.enum(['scripted', 'inbox']),
    phonePollMs: ms,
    /** Demo mode for recording the video: tap marks, "You said" caption, light bar. Off unless `?demo=1`. */
    demo: z.boolean(),
  })
  .refine((c) => c.agent === 'scripted' || c.simApiUrl !== undefined, { path: ['simApiUrl'], message: 'The remote agent needs a sim-api URL' })
  .refine((c) => c.turnBudgetMs >= c.agentTimeoutMs, { path: ['turnBudgetMs'], message: 'The turn budget must cover the agent timeout' });
export type SimConfig = z.infer<typeof ConfigSchema>;

/** Same-origin path the fault-injection E2E tests intercept. */
const DEV_SIM_API_PATH = '/sim-api';

export function parseConfig(env: Readonly<Record<string, string | undefined>>, search: string, isDev: boolean): Result<SimConfig, ErrorEnvelope> {
  const params = new URLSearchParams(search);
  const override = isDev ? params.get('agent') : null;
  const fakeSpeech = isDev && params.get('voice') === 'fake';
  const agent = override ?? env['VITE_AGENT'] ?? 'scripted';
  const parsed = ConfigSchema.safeParse({
    agent,
    simApiUrl: env['VITE_SIM_API_URL'] ?? (override === 'remote' ? DEV_SIM_API_PATH : undefined),
    agentTimeoutMs: env['VITE_AGENT_TIMEOUT_MS'] ?? 8_000,
    turnBudgetMs: env['VITE_TURN_BUDGET_MS'] ?? 10_000,
    homeTimeZone: env['VITE_HOME_TIME_ZONE'] ?? DEFAULT_HOME_TIME_ZONE,
    phone: env['VITE_PHONE'] ?? 'scripted',
    phonePollMs: env['VITE_PHONE_POLL_MS'] ?? 5_000,
    demo: params.get('demo') === '1',
    voice: {
      speech: fakeSpeech ? 'fake' : 'browser',
      lang: env['VITE_VOICE_LANG'] ?? 'en-US',
      voiceName: env['VITE_VOICE_NAME'],
      speakReplies: env['VITE_SPEAK_REPLIES'] ?? 'true',
      listenTimeoutMs: env['VITE_LISTEN_TIMEOUT_MS'] ?? 8_000,
      // A network voice offline hangs silently: give up on audio after 2 s (spike S5), plus 1 s when the
      // studio voice may come first and fall back (F8d, #25).
      speakStartTimeoutMs: env['VITE_SPEAK_START_TIMEOUT_MS'] ?? 3_000,
      studioVoiceTimeoutMs: env['VITE_STUDIO_VOICE_TIMEOUT_MS'] ?? 1_500,
      speakTimeoutBaseMs: env['VITE_SPEAK_TIMEOUT_BASE_MS'] ?? 4_000,
      speakTimeoutPerCharMs: env['VITE_SPEAK_TIMEOUT_PER_CHAR_MS'] ?? 80,
    },
  });
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message.slice(0, 200) }));
  return err(toolError('invalid_config', 'The simulator configuration is invalid.', { details: { issues } }));
}
