import { LogEntrySchema, type LogEntry } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { pollySpeech, type PollyClientLike } from '../src/adapters/polly.js';

// The Polly adapter (F8d part 3, #25): one SynthesizeSpeech per reply text, plain text (never SSML), mp3,
// neural, the voice from config, an explicit timeout. A stub client: Polly is never called (cost rule).

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4]);
const INPUT = { text: 'Your battery is at 64%.', engine: 'neural' as const, voice: 'Joanna', correlationId: '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60' };

function setup(send: PollyClientLike['send'], timeoutMs = 1000) {
  const logs: LogEntry[] = [];
  const sent: unknown[] = [];
  const client: PollyClientLike = {
    send: (command, options) => {
      sent.push(command.input);
      return send(command, options);
    },
  };
  return { port: pollySpeech({ client, timeoutMs, log: (l) => logs.push(l) }), logs, sent };
}

const audio = (bytes: Uint8Array) => Promise.resolve({ AudioStream: { transformToByteArray: () => Promise.resolve(bytes) } });
const awsError = (name: string, status: number, fault: 'client' | 'server') => Object.assign(new Error(`${name}: arn:aws:iam::123456789012:role/x`), { name, $fault: fault, $metadata: { httpStatusCode: status } });

describe('pollySpeech', () => {
  it('asks for plain text (TextType text, never SSML) as mp3 with the configured voice and engine', async () => {
    const { port, sent } = setup(() => audio(MP3));
    expect(await port.synthesize(INPUT)).toEqual({ ok: true, value: MP3 });
    expect(sent).toEqual([{ Text: INPUT.text, TextType: 'text', OutputFormat: 'mp3', VoiceId: 'Joanna', Engine: 'neural', LanguageCode: 'en-US' }]);
  });

  it.each([
    ['throttling', awsError('ThrottlingException', 400, 'client')],
    ['a service failure', awsError('ServiceFailureException', 500, 'server')],
    ['a network failure', Object.assign(new Error('connect'), { code: 'ECONNRESET' })],
  ])('answers polly_unavailable for %s (the browser voice reads the reply), logged without the SDK text', async (_case, error) => {
    const { port, logs } = setup(() => Promise.reject(error));
    expect(await port.synthesize(INPUT)).toMatchObject({ ok: false, error: { code: 'polly_unavailable', category: 'dependency_unavailable' } });
    expect(logs).toMatchObject([{ level: 'warn', code: 'polly_unavailable', correlationId: INPUT.correlationId }]);
    // Polly answered with an error: nothing was synthesized, so the characters can go back. A cut connection may have been billed.
    expect(await port.synthesize(INPUT)).toMatchObject({ mayHaveBilled: (error as { $metadata?: unknown }).$metadata === undefined });
    expect(JSON.stringify(logs)).not.toContain('arn:aws');
    for (const line of logs) expect(LogEntrySchema.safeParse(line).success).toBe(true);
  });

  it.each([
    ['a denied call (IAM)', awsError('AccessDeniedException', 403, 'client')],
    ['a voice that does not exist', awsError('InvalidParameterValueException', 400, 'client')],
    ['an engine the voice does not support', awsError('EngineNotSupportedException', 400, 'client')],
  ])('answers unexpected_error for %s: our setup, so the internal-errors alarm fires', async (_case, error) => {
    const { port, logs } = setup(() => Promise.reject(error));
    expect(await port.synthesize(INPUT)).toMatchObject({ ok: false, error: { code: 'unexpected_error', category: 'internal' } });
    expect(logs[0]).toMatchObject({ level: 'error', code: 'unexpected_error', errorName: error.name, details: { httpStatus: error.$metadata.httpStatusCode } });
  });

  it('gives up after its own timeout: polly_unavailable, and the request is aborted', async () => {
    let aborted = false;
    const { port, logs } = setup(
      (_command, options) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
      20,
    );
    expect(await port.synthesize(INPUT)).toMatchObject({ ok: false, error: { code: 'polly_unavailable' }, mayHaveBilled: true });
    expect(aborted).toBe(true);
    expect(logs[0]).toMatchObject({ code: 'polly_unavailable', details: { timedOut: true } });
  });

  it('answers polly_unavailable for an empty audio stream', async () => {
    const { port } = setup(() => audio(new Uint8Array()));
    expect(await port.synthesize(INPUT)).toMatchObject({ ok: false, error: { code: 'polly_unavailable' } });
  });
});
