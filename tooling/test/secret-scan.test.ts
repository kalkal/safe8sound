import { describe, expect, it } from 'vitest';
import { scanAddedLines } from '../src/secret-scan.mjs';

// Fake secrets are assembled at runtime so this file never contains one literally.
const fake = {
  awsKey: ['AKIA', 'Q3XZ7L2M9N4P5R6T'].join(''),
  githubToken: ['ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join(''),
  privateKey: ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''),
  homeIp: ['192', '168', '1', '57'].join('.'),
};

const diff = (file: string, ...lines: string[]) => [`+++ b/${file}`, '@@ -0,0 +1 @@', ...lines.map((l) => `+${l}`)].join('\n');

describe('fallback secret scan (used when gitleaks is not installed)', () => {
  it('finds AWS keys, GitHub tokens and private keys in added lines', () => {
    const findings = scanAddedLines(diff('src/a.ts', `const k = '${fake.awsKey}';`, `const gh = '${fake.githubToken}';`, fake.privateKey));
    expect(findings.map((f) => f.rule)).toEqual(['aws-access-key', 'github-token', 'private-key']);
    expect(findings[0]).toMatchObject({ file: 'src/a.ts', line: 1 });
  });

  it('finds private IPv4 addresses (the home network must never reach the repo)', () => {
    expect(scanAddedLines(diff('docs/setup.md', `logger at ${fake.homeIp}`))).toMatchObject([{ rule: 'private-ipv4' }]);
  });

  it('finds password-like assignments with a real value', () => {
    expect(scanAddedLines(diff('.env.example', `DATALOGGER_PASSWORD=${['hunter', '2hunter2'].join('')}`))).toHaveLength(1);
    const empty = ['DATALOGGER', 'PASSWORD='].join('_');
    expect(scanAddedLines(diff('.env.example', empty))).toHaveLength(0);
  });

  it('does not flag ordinary code about design tokens', () => {
    const text = diff(
      'packages/design-tokens/src/build.ts',
      'export type TokenTree = Record<string, unknown>;',
      "console.log(`tokens: ${String(n)} custom properties`);",
      'const tokens = source[group];',
    );
    expect(scanAddedLines(text)).toEqual([]);
  });

  it('ignores removed and context lines, localhost and lines marked gitleaks:allow', () => {
    const text = [
      '+++ b/src/b.ts',
      `-const old = '${fake.awsKey}';`,
      ` const ctx = '${fake.awsKey}';`,
      "+const host = '127.0.0.1';",
      `+const example = '${fake.homeIp}'; // gitleaks:allow`,
    ].join('\n');
    expect(scanAddedLines(text)).toEqual([]);
  });
});
