import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';
import type { QuotaLimits } from './quota.js';
import type { TokenKey } from './token.js';

export interface SimApiConfig {
  /** sha256(code) hex -> code id. Only hashes are configured; the codes themselves never are. */
  readonly demoCodes: ReadonlyMap<string, string>;
  /** The first key signs; every key verifies (rotation). */
  readonly keys: readonly TokenKey[];
  readonly tokenTtlS: number;
  readonly skewS: number;
  readonly allowedOrigins: readonly string[];
  readonly limits: QuotaLimits;
  /** Kill switch (plan §13.2.4). */
  readonly demoEnabled: boolean;
  /** Replies spoken by Polly (F8d, #25, approved in #25): off unless switched on; one voice. */
  readonly speech: { readonly enabled: boolean; readonly engine: SpeechEngine; readonly voice: string };
  readonly maxBodyBytes: number;
  /**
   * The origin secrets (#243): the CloudFront distribution adds the current one to every /api request. Non-empty on
   * AWS, where a request without one is refused, so the Function URL is not usable directly; the previous one is
   * accepted too during a rotation. Empty locally: no check, and the socket IP counts.
   */
  readonly originSecrets: readonly string[];
}

const MIN_ORIGIN_SECRET = 32;

const invalid = (message: string) => err(toolError('invalid_config', message));

/**
 * How long sim-api waits for the agent when nothing sets it: the agent deadline plus its margin from the timing table
 * of a turn (infra/cdk.json cold-reserve:turnTiming, #270). On AWS the stack sets it from the table; a test keeps
 * this default equal to it.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 14_000;

export const SPEECH_ENGINES = ['neural', 'generative', 'standard'] as const;
export type SpeechEngine = (typeof SPEECH_ENGINES)[number];
const ID = /^[a-z][a-z0-9-]{0,31}$/;

const int = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const NumbersSchema = z.object({
  tokenTtlS: int(60, 3600),
  skewS: int(0, 300),
  turnsPerCodePerDay: int(1, 10_000),
  turnsGlobalPerDay: int(1, 100_000),
  toolCallsPerCodePerDay: int(1, 10_000),
  readCallsPerCodePerDay: int(1, 10_000),
  readCallsGlobalPerDay: int(1, 1_000_000),
  codeAttemptsPerIpPerHour: int(1, 1000),
  speechCharsPerCodePerDay: int(1, 1_000_000),
  speechCharsGlobalPerDay: int(1, 10_000_000),
  phoneReadsPerSessionPerMinute: int(1, 600),
  phoneReadsPerCodePerMinute: int(1, 600),
  maxBodyBytes: int(256, 1_048_576),
});

function entries(raw: string | undefined): [string, string][] {
  return (raw ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .map((e) => {
      const i = e.indexOf(':');
      return i <= 0 ? ['', e] : [e.slice(0, i), e.slice(i + 1)];
    });
}

/** The settings that are not secrets: they can be checked before any secret is read (Copilot on #156). */
export type PlainSimApiSettings = Omit<SimApiConfig, 'demoCodes' | 'keys' | 'originSecrets'>;

export function loadPlainSimApiSettings(env: Readonly<Record<string, string | undefined>>): Result<PlainSimApiSettings, ErrorEnvelope> {
  const allowedOrigins = (env['SIM_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  // Empty behind the CloudFront proxy (K1, #244): the site calls /api on its own origin, the distribution drops that
  // Origin and refuses any other, so a request that still carries one is refused here too. Local dev lists its origin.
  if (!allowedOrigins.every((o) => z.url().safeParse(o).success)) return invalid('SIM_ALLOWED_ORIGINS lists origins, each a URL.');

  const numbers = NumbersSchema.safeParse({
    tokenTtlS: env['SIM_TOKEN_TTL_S'] ?? '3600',
    skewS: env['SIM_CLOCK_SKEW_S'] ?? '30',
    turnsPerCodePerDay: env['SIM_LIMIT_TURNS_PER_CODE'] ?? '20',
    turnsGlobalPerDay: env['SIM_LIMIT_TURNS_GLOBAL'] ?? '30',
    toolCallsPerCodePerDay: env['SIM_LIMIT_TOOL_CALLS_PER_CODE'] ?? '20',
    readCallsPerCodePerDay: env['SIM_LIMIT_READ_CALLS_PER_CODE'] ?? '200',
    readCallsGlobalPerDay: env['SIM_LIMIT_READ_CALLS_GLOBAL'] ?? '2000',
    codeAttemptsPerIpPerHour: env['SIM_LIMIT_CODE_ATTEMPTS_PER_IP_HOUR'] ?? '10',
    speechCharsPerCodePerDay: env['SIM_LIMIT_SPEECH_CHARS_PER_CODE'] ?? '6000',
    speechCharsGlobalPerDay: env['SIM_LIMIT_SPEECH_CHARS_GLOBAL'] ?? '30000',
    phoneReadsPerSessionPerMinute: env['SIM_LIMIT_PHONE_READS_PER_SESSION_PER_MINUTE'] ?? '20',
    phoneReadsPerCodePerMinute: env['SIM_LIMIT_PHONE_READS_PER_CODE_PER_MINUTE'] ?? '120',
    maxBodyBytes: env['SIM_MAX_BODY_BYTES'] ?? '16384',
  });
  if (!numbers.success) return invalid(`A SIM_* number is not valid: ${numbers.error.issues.map((i) => i.path.join('.')).join(', ')}.`);
  const { tokenTtlS, skewS, maxBodyBytes, ...limits } = numbers.data;

  // The kill switch takes true or false only (unset = on): a typo never silently leaves the demo open.
  const enabled = env['SIM_DEMO_ENABLED']?.trim().toLowerCase();
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') return invalid('SIM_DEMO_ENABLED must be true or false.');

  const speechOn = env['SIM_SPEECH_ENABLED']?.trim().toLowerCase();
  if (speechOn !== undefined && speechOn !== 'true' && speechOn !== 'false') return invalid('SIM_SPEECH_ENABLED must be true or false.');
  const engine = env['SIM_SPEECH_ENGINE'] ?? 'neural';
  if (!(SPEECH_ENGINES as readonly string[]).includes(engine)) return invalid(`SIM_SPEECH_ENGINE must be one of ${SPEECH_ENGINES.join(', ')}.`);
  const voice = env['SIM_SPEECH_VOICE'] ?? 'Joanna';
  if (!/^[A-Z][A-Za-z]{1,31}$/.test(voice)) return invalid('SIM_SPEECH_VOICE must be a Polly voice id, like Joanna.');

  return ok({ tokenTtlS, skewS, allowedOrigins, limits, demoEnabled: enabled !== 'false', maxBodyBytes, speech: { enabled: speechOn === 'true', engine: engine as SpeechEngine, voice } });
}

/** Locally from .env; on Lambda the codes and keys come from SSM SecureStrings. Messages never echo values. */
export function loadSimApiConfig(env: Readonly<Record<string, string | undefined>>): Result<SimApiConfig, ErrorEnvelope> {
  const demoCodes = new Map<string, string>();
  for (const [id, hash] of entries(env['SIM_DEMO_CODES'])) {
    if (!ID.test(id) || !/^[0-9a-f]{64}$/.test(hash)) return invalid('SIM_DEMO_CODES entries must be <codeId>:<sha256 hex of the code>.');
    demoCodes.set(hash, id);
  }
  if (demoCodes.size === 0) return invalid('SIM_DEMO_CODES is not set.');

  const keys: TokenKey[] = [];
  for (const [kid, value] of entries(env['SIM_TOKEN_KEYS'])) {
    const material = Buffer.from(value, 'base64url');
    if (!ID.test(kid)) return invalid('SIM_TOKEN_KEYS entries must be <kid>:<base64url key>.');
    if (material.length < 32) return invalid(`The key ${kid} is shorter than 32 bytes.`);
    if (keys.some((k) => k.kid === kid)) return invalid(`The key id ${kid} is listed twice.`);
    keys.push({ kid, material });
  }
  if (keys.length === 0) return invalid('SIM_TOKEN_KEYS is not set.');

  // `none` marks an empty previous parameter (it exists so a rotation needs no new IAM grant).
  const originSecrets = [env['SIM_ORIGIN_SECRET'], env['SIM_ORIGIN_SECRET_PREVIOUS']].filter((v): v is string => v !== undefined && v.trim() !== '' && v.trim() !== 'none').map((v) => v.trim());
  if (originSecrets.some((v) => v.length < MIN_ORIGIN_SECRET)) return invalid(`An origin secret is shorter than ${String(MIN_ORIGIN_SECRET)} characters.`);
  if (env['SIM_ORIGIN_SECRET_PREVIOUS'] !== undefined && env['SIM_ORIGIN_SECRET'] === undefined) return invalid('SIM_ORIGIN_SECRET_PREVIOUS needs SIM_ORIGIN_SECRET.');

  const plain = loadPlainSimApiSettings(env);
  return plain.ok ? ok({ demoCodes, keys, originSecrets, ...plain.value }) : plain;
}
