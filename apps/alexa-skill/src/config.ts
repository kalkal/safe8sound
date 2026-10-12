import { TempUnitSchema, err, ok, toolError, type ErrorEnvelope, type Result, type TempUnit } from '@cold-reserve/contracts';
import { z } from 'zod';
import type { SkillTiming } from './handler.js';

/** The function's settings: names and timings only. The skill ID comes from the deploy, the token from SSM. */
export interface SkillConfig {
  readonly skillId: string;
  readonly mcpUrl: string;
  readonly tokenParameter: string;
  readonly timing: SkillTiming;
  readonly tempUnit: TempUnit;
}

const ms = (max: number) => z.coerce.number().int().min(50).max(max);

const EnvSchema = z
  .object({
    ALEXA_SKILL_ID: z.string().regex(/^amzn1\.ask\.skill\.[0-9a-f-]{36}$/),
    ALEXA_MCP_URL: z.url({ protocol: /^https?$/ }),
    ALEXA_MCP_TOKEN_PARAMETER: z.string().regex(/^\/[A-Za-z0-9_./-]+$/),
    ALEXA_DEADLINE_MS: ms(7500),
    ALEXA_SSM_TIMEOUT_MS: ms(5000),
    ALEXA_MCP_TIMEOUT_MS: ms(7000),
    ALEXA_TEMP_UNIT: TempUnitSchema,
  })
  .refine((e) => e.ALEXA_SSM_TIMEOUT_MS + e.ALEXA_MCP_TIMEOUT_MS <= e.ALEXA_DEADLINE_MS, {
    path: ['ALEXA_DEADLINE_MS'],
    message: 'The SSM read and the MCP call must fit in the deadline.',
  });

/** Reads the environment; the message names the variables, never their values. */
export function loadSkillConfig(env: Readonly<Record<string, string | undefined>>): Result<SkillConfig, ErrorEnvelope> {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    return err(toolError('invalid_config', `The skill settings are not valid: ${names}.`.slice(0, 300)));
  }
  const e = parsed.data;
  return ok({
    skillId: e.ALEXA_SKILL_ID,
    mcpUrl: e.ALEXA_MCP_URL,
    tokenParameter: e.ALEXA_MCP_TOKEN_PARAMETER,
    timing: { deadlineMs: e.ALEXA_DEADLINE_MS, ssmTimeoutMs: e.ALEXA_SSM_TIMEOUT_MS, mcpTimeoutMs: e.ALEXA_MCP_TIMEOUT_MS },
    tempUnit: e.ALEXA_TEMP_UNIT,
  });
}
