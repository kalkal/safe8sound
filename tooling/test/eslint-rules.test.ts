import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { brandCastRule, e2eRule, i18nSrcCastRule, srcCastRule, unitCastRule } from '../../eslint.config.mjs';

const linter = new Linter({ configType: 'flat' });
const lint = (code: string) =>
  linter
    .verify(code, [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules: { 'no-restricted-syntax': unitCastRule } }], 'probe.ts')
    .map((m) => m.message);

describe('ESLint: branded units are created only inside packages/contracts (plan §9.4)', () => {
  it('rejects `as Watt` and the other unit casts', () => {
    for (const unit of ['Watt', 'Kilowatt', 'WattHour', 'Pct', 'Celsius', 'Minutes']) {
      expect(lint(`const x = 5 as ${unit};`), unit).toHaveLength(1);
    }
  });

  it('rejects angle-bracket casts too', () => {
    expect(lint('const x = <Watt>5;')).toHaveLength(1);
  });

  it('leaves other casts alone', () => {
    expect(lint('const x = 5 as number; const y = {} as Record<string, unknown>;')).toEqual([]);
  });
});

describe('ESLint: family message text is produced only by the i18n templates (#23)', () => {
  const lintWith = (rule: typeof brandCastRule, code: string) =>
    linter
      .verify(code, [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules: { 'no-restricted-syntax': rule } }], 'probe.ts')
      .map((m) => m.message);

  it('rejects a cast to StormMessageText everywhere by default, and still the unit casts', () => {
    expect(lintWith(brandCastRule, "const t = 'Hi' as StormMessageText;")).toHaveLength(1);
    expect(lintWith(brandCastRule, 'const x = 5 as Watt;')).toHaveLength(1);
  });

  it('lets packages/i18n (which uses the unit-only rule) build the text from its templates', () => {
    expect(lintWith(unitCastRule, "const t = 'Hi' as StormMessageText;")).toEqual([]);
  });

  it('also catches the forged forms: a namespace, a renamed import and a Zod brand', () => {
    expect(lintWith(brandCastRule, "const t = 'Hi' as contracts.StormMessageText;")).toHaveLength(1);
    expect(lintWith(brandCastRule, "import { type StormMessageText as Text } from '@cold-reserve/contracts';")).toHaveLength(1);
    expect(lintWith(brandCastRule, "import { type StormMessageText } from '@cold-reserve/contracts';")).toEqual([]);
    expect(lintWith(brandCastRule, "const Fake = z.string().brand<'StormMessageText'>();")).toHaveLength(1);
    expect(lintWith(brandCastRule, "type Fake = string & z.$brand<'StormMessageText'>;")).toHaveLength(1);
    expect(lintWith(brandCastRule, 'type Text = StormMessageText;')).toHaveLength(1);
    expect(lintWith(brandCastRule, "type Other = string & z.$brand<'Other'>;")).toEqual([]);
  });

  it('forbids `as never` in production code, where it would forge any brand', () => {
    expect(lintWith(srcCastRule, "send({ text: 'Hi' as never });")).toHaveLength(1);
    expect(lintWith(srcCastRule, "const t = 'Hi' as StormMessageText;")).toHaveLength(1);
    expect(lintWith(i18nSrcCastRule, "send({ text: 'Hi' as never });")).toHaveLength(1);
    expect(lintWith(i18nSrcCastRule, "const t = 'Hi' as StormMessageText;")).toEqual([]);
  });
});

describe('ESLint: which files get which cast rule (the real config)', () => {
  const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../', import.meta.url)) });
  const ruleFor = async (file: string) => ((await eslint.calculateConfigForFile(file)) as { rules: Record<string, unknown> }).rules['no-restricted-syntax'];
  // ESLint normalises the severity: 'error' becomes 2.
  const normalised = (rule: typeof brandCastRule) => [2, ...(rule as unknown[]).slice(1)];

  it('production code outside i18n: units, the message brand and `as never`', async () => {
    expect(await ruleFor('packages/core/src/notifications.ts')).toEqual(normalised(srcCastRule));
    expect(await ruleFor('apps/mcp-server/src/compose.ts')).toEqual(normalised(srcCastRule));
  });

  it('packages/i18n/src may build the message text, nothing else', async () => {
    expect(await ruleFor('packages/i18n/src/index.ts')).toEqual(normalised(i18nSrcCastRule));
  });

  it('tests: units and the message brand (a test may still use `as never` for a fake)', async () => {
    expect(await ruleFor('packages/core/test/notifications.test.ts')).toEqual(normalised(brandCastRule));
  });

  it('e2e specs: the test rule plus no layout classes', async () => {
    expect(await ruleFor('e2e/layout/three-bands.spec.ts')).toEqual(normalised(e2eRule));
  });

  it('contracts define the brands, so the rule is off there', async () => {
    expect(((await ruleFor('packages/contracts/src/storm.ts')) as unknown[])[0]).toBe(0);
  });
});

describe('ESLint: e2e reads the screen through slot test ids and roles, never a layout class (separation step S0)', () => {
  const lintE2e = (code: string) =>
    linter
      .verify(code, [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules: { 'no-restricted-syntax': e2eRule } }], 'probe.ts')
      .map((m) => m.message);

  it('rejects the Echo layout classes in a selector, also inside a longer one or a template', () => {
    for (const selector of ['.echo-scroll', '.band-content iframe', '.sky-layer', '.sim-dock-time', '.scenario-badge', '.answer-text', '.welcome']) {
      expect(lintE2e(`page.locator('${selector}');`), selector).toHaveLength(1);
    }
    expect(lintE2e('page.locator(`.band-head ${tag}`);')).toHaveLength(1);
  });

  it('leaves test ids, roles, other classes and plain words alone, and still applies the cast rules', () => {
    expect(lintE2e(`page.getByTestId('slot-content'); page.locator('[data-testid="screen-viewport"]'); page.locator('iframe.card-frame');`)).toEqual([]);
    expect(lintE2e(`page.getByText('Welcome home. The sky is clear.');`)).toEqual([]);
    expect(lintE2e('const x = 5 as Watt;')).toHaveLength(1);
  });
});
