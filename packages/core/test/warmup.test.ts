import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { WARMUP_EVENT, isWarmupEvent } from '../src/warmup.js';

// The scheduled warm-up (#407): the one event shape the sim-api and MCP Lambdas answer without doing any work.
// A Function URL request always carries version, rawPath, headers and requestContext at the top level, and the
// caller writes none of the top-level keys, so the exact two-key shape below can only come from a direct invoke.

/** A Function URL (payload 2.0) event whose path, headers and body say "warm-up" everywhere the caller can write. */
const lookalike = {
  version: '2.0',
  routeKey: '$default',
  rawPath: '/cold-reserve.warmup',
  rawQueryString: 'source=cold-reserve.warmup&version=1',
  headers: { source: 'cold-reserve.warmup', version: '1' },
  body: JSON.stringify(WARMUP_EVENT),
  isBase64Encoded: false,
  requestContext: { domainName: 'abc.lambda-url.us-east-1.on.aws', http: { method: 'POST', path: '/', sourceIp: '203.0.113.7' } },
};

describe('isWarmupEvent (#407)', () => {
  it('recognises the event the schedule sends, also after a JSON round trip (how Lambda delivers it)', () => {
    expect(isWarmupEvent(WARMUP_EVENT)).toBe(true);
    expect(isWarmupEvent(JSON.parse(JSON.stringify(WARMUP_EVENT)))).toBe(true);
  });

  it('never takes a Function URL request for it, whatever the caller writes in its path, query, headers or body', () => {
    expect(isWarmupEvent(lookalike)).toBe(false);
    expect(isWarmupEvent({ ...lookalike, ...WARMUP_EVENT })).toBe(false);
  });

  it('refuses any other value, extra key, missing key or different value', () => {
    for (const bad of [undefined, null, 'cold-reserve.warmup', 1, [], [WARMUP_EVENT], {}, { source: 'cold-reserve.warmup' }, { version: 1 }, { ...WARMUP_EVENT, extra: true }, { ...WARMUP_EVENT, version: '1' }, { ...WARMUP_EVENT, version: 2 }, { ...WARMUP_EVENT, source: 'aws.events' }]) {
      expect(isWarmupEvent(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isWarmupEvent(Object.assign(Object.create({ inherited: 1 }) as object, WARMUP_EVENT))).toBe(false);
  });

  it('is false for any object with other keys (property)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue(), { minKeys: 1 }), (extra) => {
        const keys = Object.keys(extra);
        fc.pre(keys.some((k) => k !== 'source' && k !== 'version'));
        expect(isWarmupEvent({ ...WARMUP_EVENT, ...extra })).toBe(false);
      }),
    );
  });
});
