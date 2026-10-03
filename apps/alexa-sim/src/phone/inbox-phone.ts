import { PhoneInboxSchema, PhoneReplyOutputSchema, type InboxMessage, type PhoneReply } from '@cold-reserve/contracts';
import { z } from 'zod';
import type { Log } from '../log.js';
import type { PhoneFeed, PhoneReplyResult } from './phone-feed.js';

// The family phone reads the real inbox (#127, review of #136): same-origin GET /phone/inbox, which the
// dev server proxies to the MCP server adding the phone's token (vite.phone-proxy.ts). The browser never
// holds the token. Polled only while the panel is on screen; a failed read keeps what is shown.
// Logs carry the code and the poll's correlation id, never a message text (it names the contact).

const INBOX_PATH = '/phone/inbox';
const REPLY_PATH = '/phone/reply';
const ProblemSchema = z.object({ code: z.string().min(1).max(64) });

export interface InboxPhoneOptions {
  readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  readonly pollMs: number;
  /** A read that takes longer is abandoned, before the next one is due (default: 80 % of pollMs). */
  readonly timeoutMs?: number;
  readonly log: Log;
  readonly newId: () => string;
}

const keyOf = (messages: readonly InboxMessage[]) => messages.map((m) => `${m.at}|${m.transition}|${m.role}`).join(',');

export function createInboxPhone(options: InboxPhoneOptions): PhoneFeed {
  let current: readonly InboxMessage[] = [];
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  // One read at a time: a slow reply can never land after a newer one and overwrite it.
  let inFlight = false;
  const timeoutMs = options.timeoutMs ?? Math.floor(options.pollMs * 0.8);

  async function poll(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      await read();
    } finally {
      inFlight = false;
    }
  }

  async function read(): Promise<void> {
    const correlationId = options.newId();
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      abort.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await options.fetchFn(INBOX_PATH, { headers: { accept: 'application/json', 'x-correlation-id': correlationId }, credentials: 'omit', signal: abort.signal });
    } catch (error) {
      options.log({ level: 'warn', code: abort.signal.aborted ? 'phone_inbox_timeout' : 'phone_inbox_unreachable', correlationId, error });
      return;
    } finally {
      clearTimeout(timeout);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      options.log({ level: 'warn', code: ProblemSchema.safeParse(body).data?.code ?? 'unexpected_error', correlationId, details: { status: response.status } });
      return;
    }
    const parsed = PhoneInboxSchema.safeParse(body);
    if (!parsed.success) {
      options.log({ level: 'warn', code: 'output_schema_violation', correlationId, details: { issues: parsed.error.issues.length } });
      return;
    }
    if (keyOf(parsed.data.messages) === keyOf(current)) return;
    current = parsed.data.messages;
    for (const listener of listeners) listener();
  }

  /** POST /phone/reply through the same proxy: the role is the proxy's token, never sent from here. */
  async function reply(answer: PhoneReply): Promise<PhoneReplyResult> {
    const correlationId = options.newId();
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      abort.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await options.fetchFn(REPLY_PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-correlation-id': correlationId },
        body: JSON.stringify({ reply: answer }),
        credentials: 'omit',
        signal: abort.signal,
      });
    } catch (error) {
      const code = abort.signal.aborted ? 'phone_reply_timeout' : 'phone_reply_unreachable';
      options.log({ level: 'warn', code, correlationId, error });
      return { ok: false, code };
    } finally {
      clearTimeout(timeout);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = ProblemSchema.safeParse(body).data?.code ?? 'unexpected_error';
      options.log({ level: 'warn', code, correlationId, details: { status: response.status } });
      const retry = Number(response.headers.get('retry-after'));
      return Number.isFinite(retry) && retry > 0 ? { ok: false, code, retryAfterMs: retry * 1000 } : { ok: false, code };
    }
    const parsed = PhoneReplyOutputSchema.safeParse(body);
    if (!parsed.success) {
      options.log({ level: 'warn', code: 'output_schema_violation', correlationId, details: { issues: parsed.error.issues.length } });
      return { ok: false, code: 'output_schema_violation' };
    }
    return parsed.data.status === undefined ? { ok: true } : { ok: true, status: parsed.data.status };
  }

  return {
    reply,
    messages: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      if (timer === undefined) {
        void poll();
        timer = setInterval(() => void poll(), options.pollMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
  };
}
