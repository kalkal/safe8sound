import { createHash } from 'node:crypto';

// K1 (#242): the site's Content-Security-Policy, computed when the site is built, because the site knows what it loads.
// The cards are srcdoc iframes: they inherit the page's policy, so the card's one inline script and one inline style
// are allowed by their hash, never with 'unsafe-inline'. Nothing remote: the API is same-origin (/api, through
// CloudFront), the Polly audio plays from a blob: URL, and no font or script comes from another origin.

const hash = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const contents = (html: string, tag: 'script' | 'style'): string[] =>
  [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1] ?? '');

/** The CSP hash of every inline script and style of a document, exactly as written. */
export function inlineHashes(html: string): { scripts: string[]; styles: string[] } {
  return { scripts: contents(html, 'script').map(hash), styles: contents(html, 'style').map(hash) };
}

export interface SiteHeaders {
  readonly contentSecurityPolicy: string;
}

/** The headers of the built site, from one card document (every card kind inlines the same script and style). */
export function siteHeaders(cardHtml: string): SiteHeaders {
  const card = inlineHashes(cardHtml);
  const unique = (list: string[]) => [...new Set(list)];
  return {
    contentSecurityPolicy: [
      "default-src 'self'",
      ["script-src 'self'", ...unique(card.scripts)].join(' '),
      ["style-src 'self'", ...unique(card.styles)].join(' '),
      "img-src 'self' data:",
      "font-src 'self'",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  };
}
