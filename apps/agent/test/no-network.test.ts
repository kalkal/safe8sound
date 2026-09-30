import { NetworkBlockedError, allowedConnections, blockedConnections } from './no-network.js';
import { get } from 'node:http';
import { createServer } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

// 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed, so a leak could not reach anyone anyway.
const TEST_NET = '192.0.2.1';

describe('network guard of the agent tests (no AWS from tests, cost rule)', () => {
  it('leaves no AWS credentials and disables instance metadata', () => {
    expect(Object.keys(process.env).filter((k) => k.startsWith('AWS_') && k !== 'AWS_EC2_METADATA_DISABLED')).toEqual([]);
    expect(process.env['AWS_EC2_METADATA_DISABLED']).toBe('true');
  });

  it('refuses HTTPS to an AWS endpoint', async () => {
    await expect(fetch('https://bedrock-runtime.us-east-1.amazonaws.com/')).rejects.toThrow();
    expect(blockedConnections).toContain('bedrock-runtime.us-east-1.amazonaws.com');
  });

  it('refuses plain HTTP through fetch', async () => {
    await expect(fetch(`http://${TEST_NET}/`)).rejects.toThrow();
    expect(blockedConnections).toContain(TEST_NET);
  });

  it('refuses plain HTTP through http.get', () => {
    expect(() => get(`http://${TEST_NET}:8080/`)).toThrow(NetworkBlockedError);
  });

  it('refuses a raw net.connect(port, host)', () => {
    expect(() => net.connect(80, TEST_NET)).toThrow(NetworkBlockedError);
  });

  it('allows the loopback, where the local MCP server runs, and records it as allowed', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    expect(await (await fetch(`http://127.0.0.1:${String(port)}/`)).text()).toBe('ok');
    expect(allowedConnections).toContain('127.0.0.1');
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('lets importing the Strands SDK happen without any outbound connection', async () => {
    const before = blockedConnections.length;
    await import('@strands-agents/sdk');
    expect(blockedConnections.length).toBe(before);
  });
});
