import { describe, expect, it } from 'vitest';
import { buildCardCsp, injectCsp } from '../src/host/card-csp.js';

describe('buildCardCsp', () => {
  it('allows nothing on the network when the resource declares no domains', () => {
    expect(buildCardCsp({ connectDomains: [], resourceDomains: [] })).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('treats a missing csp like an empty one (deny by default)', () => {
    expect(buildCardCsp(undefined)).toBe(buildCardCsp({ connectDomains: [], resourceDomains: [] }));
  });

  it('adds declared https origins to the matching directives', () => {
    const csp = buildCardCsp({ connectDomains: ['https://api.example.com'], resourceDomains: ['https://fonts.gstatic.com'] });
    expect(csp).toContain("connect-src https://api.example.com");
    expect(csp).toContain("font-src https://fonts.gstatic.com");
    expect(csp).toContain("img-src data: https://fonts.gstatic.com");
  });

  it('drops anything that is not a plain https origin', () => {
    const csp = buildCardCsp({ connectDomains: ['http://api.example.com', "https://x.example; script-src 'unsafe-eval'", '*'], resourceDomains: [] });
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
  });
});

describe('injectCsp', () => {
  it('puts the CSP meta first in the head, before any style or script', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>a{}</style></head><body></body></html>';
    const result = injectCsp(html, "default-src 'none'");
    expect(result).toEqual({
      ok: true,
      value: '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><meta charset="utf-8"><style>a{}</style></head><body></body></html>',
    });
  });

  it('refuses a document without a head instead of rendering it unprotected', () => {
    expect(injectCsp('<p>hi</p>', "default-src 'none'")).toEqual({ ok: false, error: 'no_head' });
  });
});
