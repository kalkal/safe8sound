// End-to-end check with the MCP Inspector CLI against the real local server.
// Starts the server on a free port with a throwaway token, runs the Inspector, stops the server.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inspector = join(root, 'node_modules', '@modelcontextprotocol', 'inspector', 'clients', 'launcher', 'build', 'index.js');
const token = randomBytes(24).toString('hex');
const port = 3100 + Math.floor(Math.random() * 500);
const url = `http://127.0.0.1:${port}/mcp`;
const ACCESS_VIOLATION = 3221225477; // 0xC0000005, native crash seen intermittently on this machine
const TOOL_IS_ERROR_EXIT = 5; // Inspector CLI exit code for a result with isError: true

const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), MCP_CLIENT_TOKENS: `inspector=${token}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start within 20 s')), 20_000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.once('exit', (code) => reject(new Error(`server exited early with ${code}`)));
});

let crashes = 0;
function inspect(args, headers = [`Authorization: Bearer ${token}`]) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = performance.now();
    const r = spawnSync(
      process.execPath,
      [inspector, '--cli', url, '--transport', 'http', '--format', 'json', ...headers.flatMap((h) => ['--header', h]), ...args],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    const ms = Math.round(performance.now() - started);
    if (r.status === ACCESS_VIOLATION) {
      crashes++;
      continue;
    }
    let result;
    try {
      result = JSON.parse(r.stdout).result;
    } catch {
      result = undefined; // not JSON: reported through the failing check below
    }
    return { status: r.status, ms, result, stderr: r.stderr.trim() };
  }
  return { status: ACCESS_VIOLATION, ms: 0, result: undefined, stderr: 'crashed 3 times' };
}

const checks = [];
function check(name, pass, info) {
  checks.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
}

try {
  const list = inspect(['--method', 'tools/list']);
  check('tools/list returns get_reserve_status', list.status === 0 && list.result?.tools?.some((t) => t.name === 'get_reserve_status'), `exit ${list.status}, ${list.ms} ms`);

  const strict = inspect(['--method', 'tools/list', '--strict']);
  check('tools/list --strict: no error-severity schema problems', strict.status === 0, `exit ${strict.status}${strict.stderr ? `: ${strict.stderr.slice(0, 300)}` : ''}`);

  const ok = inspect(['--method', 'tools/call', '--tool-name', 'get_reserve_status', '--tool-arg', 'homeId=home-demo']);
  check('tools/call success has structuredContent', ok.status === 0 && ok.result?.structuredContent?.homeId === 'home-demo' && !ok.result?.isError, `exit ${ok.status}, ${ok.ms} ms`);

  const bad = inspect(['--method', 'tools/call', '--tool-name', 'get_reserve_status', '--tool-arg', 'homeId=nowhere']);
  check(
    'tools/call tool error is isError + structuredContent.code',
    bad.status === TOOL_IS_ERROR_EXIT && bad.result?.isError === true && bad.result?.structuredContent?.code === 'home_not_found',
    `exit ${bad.status}, ${bad.ms} ms`,
  );

  const invalid = inspect(['--method', 'tools/call', '--tool-name', 'get_reserve_status', '--tool-args-json', '{"homeId":42}']);
  check('tools/call invalid arguments is isError + invalid_arguments', invalid.result?.structuredContent?.code === 'invalid_arguments', `exit ${invalid.status}`);

  const noToken = inspect(['--method', 'tools/list', '--stored-auth-only'], []);
  check('without token the Inspector is refused', noToken.status !== 0, `exit ${noToken.status}: ${noToken.stderr.slice(0, 200)}`);

  const wrong = inspect(['--method', 'tools/list', '--stored-auth-only'], [`Authorization: Bearer ${'x'.repeat(48)}`]);
  check('with a wrong token the Inspector is refused', wrong.status !== 0, `exit ${wrong.status}: ${wrong.stderr.slice(0, 200)}`);
} finally {
  server.kill();
}

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} Inspector checks passed; native crashes retried: ${crashes}`);
process.exit(failed ? 1 : 0);
