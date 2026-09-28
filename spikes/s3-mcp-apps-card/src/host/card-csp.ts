import { err, ok, type Result } from '../result.js';

export interface CardCspMeta {
  connectDomains?: string[] | undefined;
  resourceDomains?: string[] | undefined;
}

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

const origins = (list: string[] | undefined) => (list ?? []).filter((d) => HTTPS_ORIGIN.test(d));
const sources = (list: string[], none: string) => (list.length > 0 ? list.join(' ') : none);

/** The host, not the resource, decides the CSP: deny by default, then only the https origins the resource declared. */
export function buildCardCsp(meta: CardCspMeta | undefined): string {
  const connect = origins(meta?.connectDomains);
  const resource = origins(meta?.resourceDomains);
  return [
    "default-src 'none'",
    `script-src ${["'unsafe-inline'", ...resource].join(' ')}`,
    `style-src ${["'unsafe-inline'", ...resource].join(' ')}`,
    `img-src ${['data:', ...resource].join(' ')}`,
    `font-src ${sources(resource, "'none'")}`,
    `connect-src ${sources(connect, "'none'")}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Puts the CSP meta first in <head>, so it applies to every style and script of the card. */
export function injectCsp(html: string, csp: string): Result<string, 'no_head'> {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return err('no_head');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replaceAll('"', '&quot;')}">`;
  const at = head.index + head[0].length;
  return ok(html.slice(0, at) + meta + html.slice(at));
}
