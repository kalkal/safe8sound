import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { brandCastRule, unitCastRule } from '../../eslint.config.mjs';

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
});
