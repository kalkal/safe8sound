// Suspicious inputs (injection hardening, 22 Oct): the kinds of attack a text looks like, for one `input_flagged` log
// line. Only category names leave this module: the text itself is never logged. A flag changes nothing in what the
// request does (schemas, the guard and the tools decide that); it only lets the logs show that someone tried.
// Every pattern has bounded repetition and only the first 4,000 characters are read, so a long hostile text stays fast;
// look-alike letters are read as plain ones (NFKC) first.

export type InputKind = 'sql' | 'html' | 'path' | 'prompt_injection' | 'control_chars';

const PATTERNS: readonly (readonly [InputKind, RegExp])[] = [
  ['sql', /\b(?:union\s{1,10}select|drop\s{1,10}table|insert\s{1,10}into|delete\s{1,10}from)\b|\bor\s{1,10}'?1'?\s{0,10}=\s{0,10}'?1|';/i],
  ['html', /<\s{0,10}\/?\s{0,10}(?:script|iframe|img|svg|object|embed|style)\b|\bon[a-z]{2,20}\s{0,10}=|javascript:/i],
  ['path', /\.\.[/\\]|%2e%2e|\/etc\/passwd/i],
  ['prompt_injection', /\b(?:ignore|disregard|forget)\b[^.?!]{0,40}\b(?:instructions|rules|prompt)\b|\bsystem\s*:|\bdeveloper\s+mode\b|\breveal\b[^.?!]{0,20}\b(?:prompt|instructions)\b/i],
  ['control_chars', /[\p{Cc}\p{Cf}]/u],
];

/** The kinds a text looks like, each once, in a fixed order; none for an ordinary question or code. */
export function suspiciousKinds(text: string): InputKind[] {
  const plain = text.slice(0, 4000).normalize('NFKC');
  return PATTERNS.filter(([kind, pattern]) => pattern.test(kind === 'control_chars' ? text.slice(0, 4000) : plain)).map(([kind]) => kind);
}
