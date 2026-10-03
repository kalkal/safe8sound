import { describe, expect, it } from 'vitest';
import { s3SpeechCache, type S3ClientLike } from '../src/adapters/speech-cache-s3.js';

// The cache of spoken replies on S3 (F8d part 3, #25, approved in #25): `speech/<sha256>.mp3` in the stage's
// private bucket. A missing object is a miss; any other failure is thrown for the handler to log (the reply
// is spoken anyway). A stub client: S3 is never called.

const KEY = 'a'.repeat(64);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4]);

function setup(answer: (name: string) => Promise<unknown>, timeoutMs = 1000) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client: S3ClientLike = {
    send: (command) => {
      sent.push({ name: command.constructor.name, input: command.input as unknown as Record<string, unknown> });
      return answer(command.constructor.name) as never;
    },
  };
  return { cache: s3SpeechCache({ client, bucket: 'cold-reserve-dev-speech', timeoutMs }), sent };
}

describe('s3SpeechCache', () => {
  it('reads speech/<key>.mp3 from the bucket', async () => {
    const { cache, sent } = setup(() => Promise.resolve({ Body: { transformToByteArray: () => Promise.resolve(MP3) } }));
    expect(await cache.get(KEY)).toEqual(MP3);
    expect(sent).toEqual([{ name: 'GetObjectCommand', input: { Bucket: 'cold-reserve-dev-speech', Key: `speech/${KEY}.mp3` } }]);
  });

  it('answers a miss (undefined) for a missing object: S3 says 404 NoSuchKey when the role may list the bucket', async () => {
    const missing = Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey', $fault: 'client', $metadata: { httpStatusCode: 404 } });
    const { cache } = setup(() => Promise.reject(missing));
    expect(await cache.get(KEY)).toBeUndefined();
  });

  it('treats a 403 AccessDenied as a real failure, never as a miss (without ListBucket a miss is a 403: the stack grants it)', async () => {
    const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $fault: 'client', $metadata: { httpStatusCode: 403 } });
    const { cache } = setup(() => Promise.reject(denied));
    await expect(cache.get(KEY)).rejects.toBe(denied);
  });

  it('counts reading the body inside the timeout: a body that stalls is aborted too (review of #195)', async () => {
    const client: S3ClientLike = {
      send: (_command, options) =>
        Promise.resolve({
          Body: {
            transformToByteArray: () =>
              new Promise<Uint8Array>((_resolve, reject) => {
                options?.abortSignal?.addEventListener('abort', () => {
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                });
              }),
          },
        }),
    };
    await expect(s3SpeechCache({ client, bucket: 'b', timeoutMs: 20 }).get(KEY)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws any other failure, for the handler to log', async () => {
    const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    const { cache } = setup(() => Promise.reject(denied));
    await expect(cache.get(KEY)).rejects.toBe(denied);
  });

  it('writes the mp3 with its content type', async () => {
    const { cache, sent } = setup(() => Promise.resolve({}));
    await cache.put(KEY, MP3);
    expect(sent).toEqual([{ name: 'PutObjectCommand', input: { Bucket: 'cold-reserve-dev-speech', Key: `speech/${KEY}.mp3`, Body: MP3, ContentType: 'audio/mpeg' } }]);
  });

  it('refuses a key that is not a sha256 hex, so nothing can write outside speech/', async () => {
    const { cache, sent } = setup(() => Promise.resolve({}));
    await expect(cache.put('../other/thing', MP3)).rejects.toBeInstanceOf(RangeError);
    await expect(cache.get('x')).rejects.toBeInstanceOf(RangeError);
    expect(sent).toEqual([]);
  });

  it('gives up after its own timeout (the request is aborted), as a thrown failure', async () => {
    let aborted = false;
    const client: S3ClientLike = {
      send: (_command, options) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    };
    await expect(s3SpeechCache({ client, bucket: 'b', timeoutMs: 20 }).get(KEY)).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
  });
});
