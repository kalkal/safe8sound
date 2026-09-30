import net from 'node:net';

// Imported first by every agent test: proves that tests cannot reach AWS (cost rule).
// 1) no credentials and no instance metadata for the AWS SDK to find;
// 2) every TCP connection that is not to the loopback fails the test.
for (const key of Object.keys(process.env)) if (key.startsWith('AWS_')) Reflect.deleteProperty(process.env, key);
process.env['AWS_EC2_METADATA_DISABLED'] = 'true';

export class NetworkBlockedError extends Error {
  override readonly name = 'NetworkBlockedError';
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const blockedConnections: string[] = [];
export const allowedConnections: string[] = [];

/**
 * The target host of a Socket#connect call. net.connect/http/fetch call it with ONE normalized
 * array argument ([options, callback]); direct calls pass (options) or (port, host).
 */
const hostOf = (args: unknown[]): string | undefined => {
  const a: unknown[] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  const [first, second] = a;
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: string; port?: unknown; path?: string };
    // http passes the URL path in `path` too: a host or a port makes it a network connection.
    if (options.host !== undefined || options.port !== undefined) return options.host ?? 'localhost';
    return options.path === undefined ? 'localhost' : undefined; // a bare path is IPC

  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) return typeof second === 'string' ? second : 'localhost';
  return undefined; // IPC path given as a string
};

// eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied below with the socket as `this`
const original = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const host = hostOf(args);
  if (host !== undefined && !LOOPBACK.has(host)) {
    blockedConnections.push(host);
    throw new NetworkBlockedError(`Agent tests may only connect to the loopback, not to ${host}.`);
  }
  if (host !== undefined) allowedConnections.push(host);
  return original.apply(this, args);
};
