import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// "Leo's room" is written once, by core's roomNameOf (owner, 21 Oct): every server text, scripted answer, card and phone
// message reads it there, so with no one at risk nothing says Leo. Only the prompts, their few-shot examples and the
// eval fixtures may say it on their own (the model must learn the name). Comments do not count; tests are not scanned.
const ROOT = join(import.meta.dirname, '..', '..');
const SCANNED = ['packages', 'apps'];
const SOURCE = /\.(ts|tsx|json|css|md)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'test', 'dist', 'generated', 'cdk.out']);
const ALLOWED = [
  'packages/core/src/household.ts',
  /^apps\/agent\/prompts\//,
  /^apps\/agent\/evals\//,
  /^apps\/agent\/src\/evals\//,
  'apps/agent/src/prompts.generated.ts',
];
const LITERAL = /Leo['’]s room/;

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : filesUnder(path);
    return SOURCE.test(name) ? [path] : [];
  });

const allowed = (file: string) => ALLOWED.some((rule) => (typeof rule === 'string' ? rule === file : rule.test(file)));
/** The code without its comments: a line comment, or a block comment, may describe the room by its name. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

describe('room display names', () => {
  it("writes \"Leo's room\" only in core's roomNameOf, the prompts and the eval fixtures", () => {
    const offenders = SCANNED.flatMap((dir) => filesUnder(join(ROOT, dir)))
      .map((path) => relative(ROOT, path).replaceAll('\\', '/'))
      .filter((file) => !allowed(file) && LITERAL.test(withoutComments(readFileSync(join(ROOT, file), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
