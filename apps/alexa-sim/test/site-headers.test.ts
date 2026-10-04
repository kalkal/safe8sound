import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inlineHashes, siteHeaders } from '../scripts/site-headers-lib.js';

// K1 (#242): the site's Content-Security-Policy, computed at build time. The cards are srcdoc iframes, which inherit
// the page's CSP, so the card's one inline script and one inline style are allowed by hash, never 'unsafe-inline'.

const sha = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const CARD = '<!doctype html><html><head><style>\n.a{color:red}\n</style></head><body><script type="module">console.log(1)</script></body></html>';

describe('inlineHashes', () => {
  it('hashes each inline script and style exactly as written', () => {
    expect(inlineHashes(CARD)).toEqual({ scripts: [sha('console.log(1)')], styles: [sha('\n.a{color:red}\n')] });
  });

  it('finds none in a document without inline code', () => {
    expect(inlineHashes('<html><head></head><body></body></html>')).toEqual({ scripts: [], styles: [] });
  });
});

describe('siteHeaders', () => {
  const csp = siteHeaders(CARD).contentSecurityPolicy;
  const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `));

  it('allows only the site itself, plus the card code by hash', () => {
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('script-src')).toBe(`script-src 'self' ${sha('console.log(1)')}`);
    expect(directive('style-src')).toBe(`style-src 'self' ${sha('\n.a{color:red}\n')}`);
    expect(directive('connect-src')).toBe("connect-src 'self'");
    expect(directive('media-src')).toBe("media-src 'self' blob:");
    expect(directive('img-src')).toBe("img-src 'self' data:");
  });

  it('never allows unsafe-inline, unsafe-eval or a remote origin, and is never framed', () => {
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
  });
});
