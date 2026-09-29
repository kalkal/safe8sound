import { toolError, type ErrorEnvelope } from '@cold-reserve/contracts';
import type { z } from 'zod';

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

// Contract limits on error details (packages/contracts, ErrorDetailsSchema).
const MAX_ISSUES = 20;
const MAX_PATH = 120;
const MAX_MESSAGE = 200;

/** `invalid_config`: bad simulator data is our bug, never the caller's. */
export function invalidConfig(what: string, issues: readonly ConfigIssue[]): ErrorEnvelope {
  return toolError('invalid_config', `${what} is invalid.`, {
    details: {
      issues: issues.slice(0, MAX_ISSUES).map((i) => ({ path: i.path.slice(0, MAX_PATH), message: i.message.slice(0, MAX_MESSAGE) || 'Invalid value' })),
    },
  });
}

export const zodIssues = (error: z.ZodError): ConfigIssue[] => error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
