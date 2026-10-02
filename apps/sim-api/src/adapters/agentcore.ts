import { createHash } from 'node:crypto';
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { TurnFailureSchema, TurnReplySchema, err, ok, toolError, type ErrorEnvelope, type LogEntry, type Result, type TurnReply } from '@cold-reserve/contracts';
import type { ErrorLine, TurnAgentPort } from '../handler.js';
import { fromAgentFailure } from './agent-http.js';

/** The one call sim-api makes to AgentCore: the real BedrockAgentCoreClient, or a fake in tests. */
export interface AgentCoreClientLike {
  send(command: InvokeAgentRuntimeCommand, options?: { abortSignal?: AbortSignal }): Promise<{ response?: { transformToString(): Promise<string> } | undefined }>;
}

/** AgentCore answered for the container: the container (or the service) failed, a retry may work. */
const TRANSIENT: ReadonlySet<string> = new Set(['RuntimeClientError', 'ThrottlingException', 'ServiceQuotaExceededException', 'InternalServerException', 'RetryableConflictException', 'TimeoutError']);
/** No HTTP answer at all: the network or DNS failed on the way to AgentCore. */
const NETWORK: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

/** Transient: a retry may work. A bare TypeError or a non-Error throw is a bug of ours, never hidden as AWS (review of #152). */
const isTransient = (cause: unknown): boolean =>
  cause instanceof Error && (TRANSIENT.has(cause.name) || NETWORK.has(String((cause as { code?: unknown }).code)));

/**
 * The agent on AgentCore Runtime (#17, G1c): InvokeAgentRuntime, signed with sim-api's IAM role by the SDK.
 * - One runtime session per sandbox home (a hash of the home, never the home itself), so a visitor keeps
 *   their conversation while the session lives.
 * - The agent answers expected failures as a 200 TurnFailure (approved in #17), turned back here into the
 *   same error with a fixed message (`fromAgentFailure`, shared with the HTTP adapter).
 * - A 424 RuntimeClientError (the container failed) and the other transient AWS errors are
 *   agent_unavailable; access, validation and not-found errors are our setup: unexpected_error. Both logged,
 *   with the error name and HTTP status only, never the SDK text.
 */
export function agentCoreTurnAgent(opts: { runtimeArn: string; timeoutMs: number; client: AgentCoreClientLike; log?: (line: ErrorLine) => void }): TurnAgentPort {
  const logFailure = (error: ErrorEnvelope, correlationId: string, cause: unknown) => {
    const status = (cause as { $metadata?: { httpStatusCode?: unknown } } | null | undefined)?.$metadata?.httpStatusCode;
    const line: LogEntry = {
      ts: new Date().toISOString(),
      level: error.category === 'internal' ? 'error' : 'warn',
      component: 'sim-api',
      message: error.code,
      correlationId,
      code: error.code,
      category: error.category,
      errorName: cause instanceof Error ? cause.name : typeof cause,
      ...(typeof status === 'number' ? { details: { httpStatus: status } } : {}),
    };
    opts.log?.(line);
  };

  return {
    async ask({ home, question, correlationId }): Promise<Result<TurnReply, ErrorEnvelope>> {
      const abortSignal = AbortSignal.timeout(opts.timeoutMs);
      let text: string;
      try {
        const output = await opts.client.send(
          new InvokeAgentRuntimeCommand({
            agentRuntimeArn: opts.runtimeArn,
            runtimeSessionId: createHash('sha256').update(home).digest('hex'),
            contentType: 'application/json',
            accept: 'application/json',
            payload: new TextEncoder().encode(JSON.stringify({ prompt: question, home, correlationId })),
          }),
          { abortSignal },
        );
        text = (await output.response?.transformToString()) ?? '';
      } catch (cause) {
        if (abortSignal.aborted) return err(toolError('agent_timeout', `The assistant did not answer within ${String(opts.timeoutMs)} ms.`));
        const error = isTransient(cause)
          ? toolError('agent_unavailable', 'The assistant is not available right now. Try again in a moment.')
          : toolError('unexpected_error', 'Something went wrong on our side.');
        logFailure(error, correlationId, cause);
        return err(error);
      }

      const body = parse(text);
      const reply = TurnReplySchema.safeParse(body);
      if (reply.success) return ok(reply.data);
      const failure = TurnFailureSchema.safeParse(body);
      if (failure.success) return err(fromAgentFailure(failure.data, opts.log));
      return err(toolError('output_schema_violation', 'The assistant sent a reply in an unexpected format.'));
    },
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
