import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { readParameter, type ReadParameterOptions } from './parameters.js';

/**
 * Reads one SSM SecureString by name (R14, #17): the value, `invalid_config` (our setup: retrying cannot
 * help) or `config_unavailable` (transient: the next request tries again). Messages name the parameter,
 * never its value or the SDK text.
 */
export type ParameterReader = (name: string) => Promise<Result<string, ErrorEnvelope>>;

/** The read timeout from a raw setting (an env value as it is): finite and positive, else 2 s (review of #162). */
export const ssmTimeoutMs = (raw: number | string | undefined): number => {
  const ms = typeof raw === 'string' && raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 2000;
};

/** The Lambda transport: the AWS Parameters and Secrets extension on localhost, no SDK in the bundle. */
export const extensionReader = (options: Omit<ReadParameterOptions, 'timeoutMs'> & { timeoutMs: number | string | undefined }): ParameterReader => {
  const settled: ReadParameterOptions = { ...options, timeoutMs: ssmTimeoutMs(options.timeoutMs) };
  return (name) => readParameter(name, settled);
};

/**
 * The SDK's GetParameter call, given by the caller (`(input, o) => client.send(new GetParameterCommand(input), o)`),
 * so this package needs no AWS SDK.
 */
export type GetParameter = (input: { Name: string; WithDecryption: true }, options: { abortSignal: AbortSignal }) => Promise<{ Parameter?: { Value?: string | undefined } | undefined }>;

/** SDK errors that mean our setup is wrong (name, permissions, key): retrying cannot help. */
const SETUP_ERRORS: ReadonlySet<string> = new Set(['ParameterNotFound', 'ParameterVersionNotFound', 'AccessDeniedException', 'ValidationException', 'InvalidKeyId']);

/** The SDK transport (AgentCore, where there is no extension): explicit timeout, the same answers. */
export function sdkReader(deps: { getParameter: GetParameter; timeoutMs: number | string | undefined }): ParameterReader {
  const timeoutMs = ssmTimeoutMs(deps.timeoutMs);
  return async (name) => {
    const abortSignal = AbortSignal.timeout(timeoutMs);
    let value: string | undefined;
    try {
      value = (await deps.getParameter({ Name: name, WithDecryption: true }, { abortSignal })).Parameter?.Value;
    } catch (e) {
      const errorName = e instanceof Error ? e.name : '';
      if (!abortSignal.aborted && SETUP_ERRORS.has(errorName)) return err(toolError('invalid_config', `Parameter ${name} cannot be read (${errorName}).`));
      return err(toolError('config_unavailable', `Parameter ${name} could not be read yet${abortSignal.aborted ? ` (timed out after ${String(timeoutMs)} ms)` : ''}.`));
    }
    return typeof value === 'string' ? ok(value) : err(toolError('invalid_config', `Parameter ${name} has no string value.`));
  };
}

/** A loader whose first success is kept for good; a failure is not kept, so the next call tries again. */
export function cachedOnSuccess<T, E>(load: () => Promise<Result<T, E>>): () => Promise<Result<T, E>> {
  let kept: Result<T, E> | undefined;
  return async () => {
    if (kept !== undefined) return kept;
    const result = await load();
    if (result.ok) kept = result;
    return result;
  };
}
