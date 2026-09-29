import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface LocalServer {
  readonly url: string;
  readonly token: string;
  stop(): void;
}

/**
 * Starts the real local Node entry (src/local.ts) in its own process, on 127.0.0.1, with a throwaway
 * token for `client`. By default it listens on port 0, so the OS picks a free port and the URL is read
 * from the server's log line; the acceptance run fixes 3316.
 */
export async function startLocalServer(opts: { client: string; port?: number; env?: Record<string, string> }): Promise<LocalServer> {
  const token = randomBytes(24).toString('hex');
  const port = opts.port ?? 0;
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/local.ts'], {
    cwd: APP_ROOT,
    env: { ...process.env, ...opts.env, PORT: String(port), MCP_CLIENTS: `${opts.client}@demo=${token}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the local server did not start within 30 s'));
    }, 30_000);
    child.stdout?.on('data', (d: Buffer) => {
      const found = /listening on (\S+)"/.exec(String(d));
      if (found?.[1]) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the local server exited early with ${String(code)}`));
    });
  });
  return { url, token, stop: () => child.kill() };
}
