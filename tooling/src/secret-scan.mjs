// Pre-commit secret scan. Runs gitleaks on the staged changes when it is installed; otherwise
// falls back to a few high-signal patterns and says so. CI always runs the real gitleaks.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @typedef {{ rule: string, file: string, line: number }} Finding */

const RULES = [
  { rule: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { rule: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { rule: 'private-key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { rule: 'private-ipv4', pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/ },
  {
    rule: 'password-assignment',
    // A credential-named key (DATALOGGER_PASSWORD, apiKey, AUTH_TOKEN...) followed by a literal value.
    pattern: /\b[A-Za-z_]*(?:password|passwd|secret|api_?key|access_?token|auth_?token)\s*[:=]\s*['"]?[A-Za-z0-9+/_\-!@#%^&*.~]{8,}/i,
  },
];

/**
 * Scans the added lines of a unified diff (`git diff --cached -U0`).
 * @param {string} diff
 * @returns {Finding[]}
 */
export function scanAddedLines(diff) {
  /** @type {Finding[]} */
  const findings = [];
  let file = '';
  let line = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('+++ ')) {
      file = text.replace(/^\+\+\+ (?:b\/)?/, '');
      line = 0;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      line = Number(hunk[1]) - 1;
      continue;
    }
    if (!text.startsWith('+')) continue;
    line++;
    if (text.includes('gitleaks:allow')) continue;
    for (const { rule, pattern } of RULES) {
      if (pattern.test(text)) findings.push({ rule, file, line });
    }
  }
  return findings;
}

function hasGitleaks() {
  const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  return probe.status === 0;
}

function main() {
  if (hasGitleaks()) {
    const run = spawnSync('gitleaks', ['git', '--pre-commit', '--staged', '--redact', '--no-banner', '--config', '.gitleaks.toml'], {
      stdio: 'inherit',
    });
    process.exit(run.status ?? 1);
  }
  console.error('secret-scan: gitleaks is not installed; running the built-in fallback patterns (CI runs gitleaks).');
  const diff = spawnSync('git', ['diff', '--cached', '-U0', '--no-color'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (diff.status !== 0) {
    console.error(`secret-scan: git diff failed: ${diff.stderr}`);
    process.exit(1);
  }
  const findings = scanAddedLines(diff.stdout);
  for (const f of findings) console.error(`secret-scan: ${f.rule} in ${f.file}:${String(f.line)}`);
  if (findings.length > 0) {
    console.error('secret-scan: remove the value (use .env) or, if it is a false positive, add "gitleaks:allow" on that line.');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
