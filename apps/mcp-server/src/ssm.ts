import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';

export interface ReadParameterOptions {
  readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  /** AWS_SESSION_TOKEN of the function: the extension's auth header. */
  readonly sessionToken: string;
  readonly timeoutMs: number;
  readonly port?: number;
}

/**
 * Reads a SecureString through the AWS Parameters and Secrets Lambda extension (local HTTP, cached),
 * so the bundle needs no AWS SDK. Failures are configuration errors; the value never reaches a message.
 */
export async function readParameter(name: string, opts: ReadParameterOptions): Promise<Result<string, ErrorEnvelope>> {
  const url = `http://localhost:${String(opts.port ?? 2773)}/systemsmanager/parameters/get?name=${encodeURIComponent(name)}&withDecryption=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs);
  try {
    const res = await opts.fetchFn(url, { headers: { 'x-aws-parameters-secrets-token': opts.sessionToken }, signal: controller.signal });
    if (!res.ok) return err(toolError('invalid_config', `Parameter ${name} could not be read (HTTP ${String(res.status)}).`));
    const body = (await res.json()) as { Parameter?: { Value?: unknown } };
    const value = body.Parameter?.Value;
    return typeof value === 'string' ? ok(value) : err(toolError('invalid_config', `Parameter ${name} has no string value.`));
  } catch (e) {
    const reason = controller.signal.aborted ? `timed out after ${String(opts.timeoutMs)} ms` : e instanceof Error ? e.name : 'failed';
    return err(toolError('invalid_config', `Parameter ${name} could not be read (${reason}).`));
  } finally {
    clearTimeout(timer);
  }
}
