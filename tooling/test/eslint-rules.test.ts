import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { unitCastRule } from '../../eslint.config.mjs';

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
