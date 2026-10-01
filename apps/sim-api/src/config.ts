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
  readonly maxBodyBytes: number;
}

const invalid = (message: string) => err(toolError('invalid_config', message));
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
  failedCodesPerIpPerHour: int(1, 1000),
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

  const allowedOrigins = (env['SIM_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (allowedOrigins.length === 0 || !allowedOrigins.every((o) => z.url().safeParse(o).success)) return invalid('SIM_ALLOWED_ORIGINS must list the simulator origin.');

  const numbers = NumbersSchema.safeParse({
    tokenTtlS: env['SIM_TOKEN_TTL_S'] ?? '3600',
    skewS: env['SIM_CLOCK_SKEW_S'] ?? '30',
    turnsPerCodePerDay: env['SIM_LIMIT_TURNS_PER_CODE'] ?? '20',
    turnsGlobalPerDay: env['SIM_LIMIT_TURNS_GLOBAL'] ?? '30',
    toolCallsPerCodePerDay: env['SIM_LIMIT_TOOL_CALLS_PER_CODE'] ?? '20',
    failedCodesPerIpPerHour: env['SIM_LIMIT_FAILED_CODES_PER_IP_HOUR'] ?? '10',
    maxBodyBytes: env['SIM_MAX_BODY_BYTES'] ?? '16384',
  });
  if (!numbers.success) return invalid(`A SIM_* number is not valid: ${numbers.error.issues.map((i) => i.path.join('.')).join(', ')}.`);
  const { tokenTtlS, skewS, maxBodyBytes, ...limits } = numbers.data;

  return ok({ demoCodes, keys, tokenTtlS, skewS, allowedOrigins, limits, demoEnabled: env['SIM_DEMO_ENABLED']?.trim().toLowerCase() !== 'false', maxBodyBytes });
}
