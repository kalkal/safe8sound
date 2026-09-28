import { describe, expect, it, vi } from 'vitest';
import { acceptFrameMessage, FrameTransport, MAX_MESSAGE_BYTES } from '../src/host/frame-guard.js';

const frame = { postMessage: vi.fn() } as unknown as Window;
const other = {} as Window;
const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

function event(overrides: Partial<{ source: unknown; origin: string; data: unknown }> = {}): MessageEvent {
  return { source: frame, origin: 'null', data: ping, ...overrides } as unknown as MessageEvent;
}

describe('acceptFrameMessage', () => {
  it('accepts a JSON-RPC message from the card frame with the opaque sandbox origin', () => {
    expect(acceptFrameMessage(event(), frame)).toEqual({ ok: true, value: ping });
  });

  it('rejects messages from any other window', () => {
    expect(acceptFrameMessage(event({ source: other }), frame)).toEqual({ ok: false, error: 'wrong_source' });
    expect(acceptFrameMessage(event({ source: null }), frame)).toEqual({ ok: false, error: 'wrong_source' });
  });

  it('rejects the card frame once it has a real origin (sandbox escaped or navigated)', () => {
    expect(acceptFrameMessage(event({ origin: 'https://evil.example' }), frame)).toEqual({ ok: false, error: 'wrong_origin' });
  });

  it('rejects anything that is not JSON-RPC 2.0', () => {
    expect(acceptFrameMessage(event({ data: 'hello' }), frame)).toEqual({ ok: false, error: 'not_jsonrpc' });
    expect(acceptFrameMessage(event({ data: { jsonrpc: '1.0', method: 'x' } }), frame)).toEqual({ ok: false, error: 'not_jsonrpc' });
    expect(acceptFrameMessage(event({ data: { jsonrpc: '2.0' } }), frame)).toEqual({ ok: false, error: 'not_jsonrpc' });
  });

  it('rejects oversized messages', () => {
    const data = { jsonrpc: '2.0', method: 'notifications/message', params: { data: 'x'.repeat(MAX_MESSAGE_BYTES) } };
    expect(acceptFrameMessage(event({ data }), frame)).toEqual({ ok: false, error: 'too_large' });
  });
});

describe('FrameTransport', () => {
  function setup() {
    const listeners = new Set<(e: MessageEvent) => void>();
    const host = {
      addEventListener: (_: 'message', l: (e: MessageEvent) => void) => listeners.add(l),
      removeEventListener: (_: 'message', l: (e: MessageEvent) => void) => listeners.delete(l),
    };
    const target = { postMessage: vi.fn() } as unknown as Window;
    const rejected: string[] = [];
    const transport = new FrameTransport(target, host, (reason) => rejected.push(reason));
    const dispatch = (e: Partial<{ source: unknown; origin: string; data: unknown }>) =>
      listeners.forEach((l) => l({ source: target, origin: 'null', data: ping, ...e } as unknown as MessageEvent));
    return { transport, target, listeners, rejected, dispatch };
  }

  it('delivers accepted messages and reports rejected ones without delivering them', async () => {
    const { transport, rejected, dispatch } = setup();
    const received: unknown[] = [];
    transport.onmessage = (m) => received.push(m);
    await transport.start();
    dispatch({});
    dispatch({ source: other });
    dispatch({ data: 'noise' });
    expect(received).toEqual([ping]);
    expect(rejected).toEqual(['wrong_source', 'not_jsonrpc']);
  });

  it('posts to the frame with "*" because a sandboxed srcdoc frame has an opaque origin', async () => {
    const { transport, target } = setup();
    await transport.start();
    await transport.send(ping as never);
    expect(target.postMessage).toHaveBeenCalledWith(ping, '*');
  });

  it('removes its listener and calls onclose on close', async () => {
    const { transport, listeners } = setup();
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.start();
    expect(listeners.size).toBe(1);
    await transport.close();
    expect(listeners.size).toBe(0);
    expect(onclose).toHaveBeenCalledOnce();
  });
});
