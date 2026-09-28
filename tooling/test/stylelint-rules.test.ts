import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';
import config from '../../stylelint.config.mjs';

async function problems(css: string): Promise<string[]> {
  const result = await stylelint.lint({ code: css, config, codeFilename: 'packages/ui-cards/src/probe.css' });
  return result.results.flatMap((r) => r.warnings.map((w) => w.rule));
}

describe('Stylelint: styles come only from tokens (plan §11.1bis.6)', () => {
  it('accepts token variables and color-mix in oklab', async () => {
    expect(
      await problems(`.card {
  color: var(--text-primary);
  background: color-mix(in oklab, var(--surface-card) 80%, var(--accent));
  border-radius: var(--radius-card);
  font-family: var(--font-body);
  font-size: var(--font-size-body);
}`),
    ).toEqual([]);
  });

  it('rejects hard-coded colors in every notation', async () => {
    expect(await problems('.a { color: #fff; }')).toContain('color-no-hex');
    expect(await problems('.a { color: white; }')).toContain('color-named');
    expect(await problems('.a { background-color: rgb(0 0 0); }')).toContain('function-disallowed-list');
    expect(await problems('.a { color: oklch(0.5 0.1 200); }')).toContain('function-disallowed-list');
  });

  it('rejects hard-coded radii, fonts and shadows', async () => {
    const rule = 'scale-unlimited/declaration-strict-value';
    expect(await problems('.a { border-radius: 16px; }')).toContain(rule);
    expect(await problems('.a { font-family: Roboto; }')).toContain(rule);
    expect(await problems('.a { font-size: 14px; }')).toContain(rule);
    expect(await problems('.a { box-shadow: 0 1px 2px black; }')).toContain(rule);
  });

  it('mixes colors in oklab only (oklch drifts toward pink on grays, spike S3)', async () => {
    expect(await problems('.a { color: color-mix(in oklch, var(--a) 50%, var(--b)); }')).toContain(
      'declaration-property-value-disallowed-list',
    );
  });

  it('forbids !important (cascade layers instead)', async () => {
    expect(await problems('.a { color: var(--accent) !important; }')).toContain('declaration-no-important');
  });
});
