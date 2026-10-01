import { GetParameterCommand, type GetParameterCommandOutput } from '@aws-sdk/client-ssm';
import { err, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { loadMcpToken, type McpToken } from './config.js';

/** The one SSM call the agent makes: the real SSMClient, or a fake in tests. */
export interface SsmClientLike {
  send(command: GetParameterCommand, options?: { abortSignal?: AbortSignal }): Promise<Pick<GetParameterCommandOutput, 'Parameter'>>;
}

/** SDK errors that mean our setup is wrong (name, permissions): retrying cannot help. */
const SETUP_ERRORS: ReadonlySet<string> = new Set(['ParameterNotFound', 'ParameterVersionNotFound', 'AccessDeniedException', 'ValidationException', 'InvalidKeyId']);

/**
 * The agent's MCP token on AgentCore (decided in #17): an SSM SecureString, decrypted with the AWS-managed
 * key, read with an explicit timeout. A transient failure is `config_unavailable` (the next invocation
 * tries again), a setup error is `invalid_config`. Neither the value nor the SDK text reach a message.
 */
export async function readMcpTokenFromSsm(name: string, deps: { client: SsmClientLike; timeoutMs: number }): Promise<Result<McpToken, ErrorEnvelope>> {
  const abortSignal = AbortSignal.timeout(deps.timeoutMs);
  let output: Pick<GetParameterCommandOutput, 'Parameter'>;
  try {
    output = await deps.client.send(new GetParameterCommand({ Name: name, WithDecryption: true }), { abortSignal });
  } catch (e) {
    const errorName = e instanceof Error ? e.name : '';
    if (!abortSignal.aborted && SETUP_ERRORS.has(errorName)) return err(toolError('invalid_config', `The MCP token parameter ${name} cannot be read (${errorName}).`));
    return err(toolError('config_unavailable', `The MCP token parameter ${name} could not be read yet${abortSignal.aborted ? ` (timed out after ${String(deps.timeoutMs)} ms)` : ''}.`));
  }
  // Same rules as AGENT_MCP_TOKEN (set, 32+ characters); the reason names the parameter, never the value.
  const token = loadMcpToken({ AGENT_MCP_TOKEN: output.Parameter?.Value });
  return token.ok ? token : err(toolError('invalid_config', `The MCP token parameter ${name} does not hold a valid token.`));
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
