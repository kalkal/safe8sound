import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { SpeechCachePort } from '../handler.js';

/** The two S3 calls the cache makes: the real S3Client, or a stub in tests. */
export interface S3ClientLike {
  send(command: GetObjectCommand | PutObjectCommand, options?: { abortSignal?: AbortSignal }): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } | undefined }>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The spoken replies already paid for (F8d part 3, #25, approved in #25): `speech/<sha256>.mp3` in the stage's
 * private bucket (SSE-S3, 30-day lifecycle, set by the stack). A missing object is a miss; any other failure
 * is thrown and the handler logs it and speaks anyway. Only sha256 keys: nothing is read or written outside
 * `speech/`. Each call has its own timeout.
 */
export function s3SpeechCache(opts: { client: S3ClientLike; bucket: string; timeoutMs: number }): SpeechCachePort {
  const objectKey = (key: string) => {
    if (!SHA256_HEX.test(key)) throw new RangeError('A speech cache key is a sha256 hex digest.');
    return `speech/${key}.mp3`;
  };
  const withTimeout = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, opts.timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async get(key) {
      const Key = objectKey(key);
      try {
        // The body is read inside the same timeout (review of #195): a stalled download is aborted too.
        return await withTimeout(async (abortSignal) => {
          const output = await opts.client.send(new GetObjectCommand({ Bucket: opts.bucket, Key }), { abortSignal });
          return await output.Body?.transformToByteArray();
        });
      } catch (e) {
        if (e instanceof Error && e.name === 'NoSuchKey') return undefined;
        throw e;
      }
    },
    async put(key, audio) {
      const Key = objectKey(key);
      await withTimeout((abortSignal) => opts.client.send(new PutObjectCommand({ Bucket: opts.bucket, Key, Body: audio, ContentType: 'audio/mpeg' }), { abortSignal }));
    },
  };
}
