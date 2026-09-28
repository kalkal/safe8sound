import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { err, ok, type Result } from '../result.js';

export type RejectReason = 'wrong_source' | 'wrong_origin' | 'not_jsonrpc' | 'too_large';

/** Card messages are small notifications and requests; anything bigger is refused. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

/**
 * Host-side check of a message that claims to come from the card iframe.
 * ext-apps' PostMessageTransport already checks the source window; this adds the
 * opaque-origin check (a sandboxed srcdoc frame without allow-same-origin reports
 * origin "null"), a size cap and a reason for every rejection, for Diagnostics.
 */
export function acceptFrameMessage(event: MessageEvent, frame: Window): Result<JSONRPCMessage, RejectReason> {
  if (event.source !== frame) return err('wrong_source');
  if (event.origin !== 'null') return err('wrong_origin');
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) return err('not_jsonrpc');
  const message = data as Record<string, unknown>;
  const isRequestOrNotification = typeof message['method'] === 'string';
  const isResponse = 'id' in message && ('result' in message || 'error' in message);
  if (message['jsonrpc'] !== '2.0' || !(isRequestOrNotification || isResponse)) return err('not_jsonrpc');
  let size: number;
  try {
    size = JSON.stringify(data).length;
  } catch {
    // Not serializable (cycles, BigInt): cannot be a JSON-RPC message.
    return err('not_jsonrpc');
  }
  if (size > MAX_MESSAGE_BYTES) return err('too_large');
  return ok(data as JSONRPCMessage);
}

interface MessageSource {
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
}

/** MCP transport between the host page and one card iframe, with every inbound message validated. */
export class FrameTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly listener = (event: MessageEvent) => {
    const accepted = acceptFrameMessage(event, this.frame);
    if (accepted.ok) this.onmessage?.(accepted.value);
    else this.onReject(accepted.error);
  };

  constructor(
    private readonly frame: Window,
    private readonly host: MessageSource,
    private readonly onReject: (reason: RejectReason) => void,
  ) {}

  async start(): Promise<void> {
    this.host.addEventListener('message', this.listener);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // "*" is the only target that reaches an opaque-origin frame; we post to this frame's window only.
    this.frame.postMessage(message, '*');
  }

  async close(): Promise<void> {
    this.host.removeEventListener('message', this.listener);
    this.onclose?.();
  }
}
