import { SynthesizeSpeechCommand, type VoiceId } from '@aws-sdk/client-polly';
import { toolError, type ErrorEnvelope, type LogEntry } from '@cold-reserve/contracts';
import type { SpeechPort, SpeechResult } from '../handler.js';

/** The one Polly call the sim-api makes: the real PollyClient, or a stub in tests. */
export interface PollyClientLike {
  send(command: SynthesizeSpeechCommand, options?: { abortSignal?: AbortSignal }): Promise<{ AudioStream?: { transformToByteArray(): Promise<Uint8Array> } | undefined }>;
}

/** Polly answered for its own side, or the network failed: a retry may work, the browser voice reads meanwhile. */
const TRANSIENT_NAMES: ReadonlySet<string> = new Set(['ThrottlingException', 'ServiceFailureException', 'ServiceUnavailableException', 'TimeoutError']);
const NETWORK_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

function isTransient(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const { $fault, $metadata, code } = e as { $fault?: unknown; $metadata?: { httpStatusCode?: unknown }; code?: unknown };
  const status = $metadata?.httpStatusCode;
  return TRANSIENT_NAMES.has(e.name) || $fault === 'server' || (typeof status === 'number' && status >= 500) || NETWORK_CODES.has(String(code));
}

/**
 * Amazon Polly behind the sim-api (F8d part 3, #25, approved in #25): one SynthesizeSpeech per reply, plain
 * text only (`TextType: 'text'`, never SSML from a reply), mp3, the engine and voice from config, an explicit
 * timeout. A transient failure is `polly_unavailable` (503: the browser voice reads the reply); access,
 * validation and voice errors are our setup: `unexpected_error`, so the internal-errors alarm fires. Every
 * failure is logged with the error name and HTTP status, never the SDK text or the reply text.
 */
export function pollySpeech(opts: { client: PollyClientLike; timeoutMs: number; log: (entry: LogEntry) => void }): SpeechPort {
  const failed = (error: ErrorEnvelope, correlationId: string, cause: unknown, timedOut: boolean): SpeechResult => {
    const status = (cause as { $metadata?: { httpStatusCode?: unknown } } | undefined)?.$metadata?.httpStatusCode;
    opts.log({
      ts: new Date().toISOString(),
      level: error.category === 'internal' ? 'error' : 'warn',
      component: 'sim-api',
      message: error.code,
      correlationId,
      code: error.code,
      category: error.category,
      errorName: cause instanceof Error ? cause.name : typeof cause,
      details: { ...(typeof status === 'number' ? { httpStatus: status } : {}), ...(timedOut ? { timedOut } : {}) },
    });
    // Polly answered with an error (an HTTP status): nothing was synthesized. A timeout or a cut connection may
    // have been billed, and so may an answer without audio.
    const answeredWithError = typeof status === 'number' && !timedOut;
    return { ok: false, error, mayHaveBilled: !answeredWithError };
  };

  return {
    async synthesize({ text, engine, voice, correlationId }) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, opts.timeoutMs);
      try {
        const output = await opts.client.send(
          new SynthesizeSpeechCommand({ Text: text, TextType: 'text', OutputFormat: 'mp3', VoiceId: voice as VoiceId, Engine: engine, LanguageCode: 'en-US' }),
          { abortSignal: controller.signal },
        );
        const bytes = await output.AudioStream?.transformToByteArray();
        if (bytes === undefined || bytes.length === 0) return failed(toolError('polly_unavailable', 'The studio voice sent no audio.'), correlationId, undefined, false);
        return { ok: true, value: bytes };
      } catch (e) {
        if (controller.signal.aborted) return failed(toolError('polly_unavailable', `The studio voice did not answer within ${String(opts.timeoutMs)} ms.`), correlationId, e, true);
        if (isTransient(e)) return failed(toolError('polly_unavailable', 'The studio voice is not available right now.'), correlationId, e, false);
        return failed(toolError('unexpected_error', 'Something went wrong on our side.'), correlationId, e, false);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
