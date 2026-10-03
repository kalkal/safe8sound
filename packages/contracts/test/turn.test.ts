import { describe, expect, it } from 'vitest';
import {
  ProblemDetailsSchema,
  SessionReplySchema,
  SessionRequestSchema,
  SpeechRequestSchema,
  StatusFactsSchema,
  ToolCallReplySchema,
  ToolCallRequestSchema,
  TurnFailureSchema,
  TurnReplySchema,
  TurnRequestSchema,
  categoryOf,
  toProblemDetails,
  toolError,
} from '../src/index.js';

// The wire between alexa-sim and sim-api (#55, #101): one schema for both apps.

describe('turn wire: POST /v1/turns', () => {
  it('accepts a trimmed question of at most 500 characters', () => {
    expect(TurnRequestSchema.parse({ question: "  What's my battery level?  " })).toEqual({ question: "What's my battery level?" });
    expect(TurnRequestSchema.safeParse({ question: '   ' }).success).toBe(false);
    expect(TurnRequestSchema.safeParse({ question: 'x'.repeat(501) }).success).toBe(false);
    expect(TurnRequestSchema.safeParse({ question: 'Hi', homeId: 'home' }).success).toBe(false);
  });

  it('accepts a reply with text, status facts and up to 4 cards', () => {
    const status = { batterySocPct: 45, origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' }, ts: '2026-07-15T12:00:00.000Z' };
    expect(StatusFactsSchema.safeParse(status).success).toBe(true);
    expect(TurnReplySchema.safeParse({ text: 'Battery at 45%.', status, cards: [] }).success).toBe(true);
    expect(TurnReplySchema.safeParse({ text: 'Too many.', cards: [{}, {}, {}, {}, {}] }).success).toBe(false);
    expect(TurnReplySchema.safeParse({ text: '' }).success).toBe(false);
  });
});

describe('session wire: POST /v1/session (demo code for a 1-hour token)', () => {
  it('accepts a demo code of 16 to 128 characters and nothing else', () => {
    expect(SessionRequestSchema.safeParse({ code: 'a'.repeat(16) }).success).toBe(true);
    expect(SessionRequestSchema.safeParse({ code: 'short' }).success).toBe(false);
    expect(SessionRequestSchema.safeParse({ code: 'a'.repeat(16), homeId: 'home' }).success).toBe(false);
  });

  it('answers a token and its expiry, nothing about the home or the code', () => {
    expect(SessionReplySchema.safeParse({ token: 'h.p.s', expiresAt: '2026-10-01T10:00:00.000Z' }).success).toBe(true);
    expect(SessionReplySchema.safeParse({ token: 'h.p.s', expiresAt: '2026-10-01T10:00:00.000Z', home: 'demo#1' }).success).toBe(false);
  });

  it('refuses a wrong code with invalid_demo_code as a 401 Problem Details', () => {
    expect(categoryOf('invalid_demo_code')).toBe('unauthorized');
    const problem = toProblemDetails(toolError('invalid_demo_code', 'That demo code is not valid.'), { instance: 'urn:uuid:00000000-0000-4000-8000-000000000000' });
    expect(ProblemDetailsSchema.parse(problem)).toMatchObject({ status: 401, code: 'invalid_demo_code' });
  });
});

describe('card tool calls: POST /v1/tools/call', () => {
  it('accepts only the card actions, with contract-checked arguments', () => {
    expect(ToolCallRequestSchema.safeParse({ name: 'apply_plan', arguments: { planId: 'plan-0001' } }).success).toBe(true);
    expect(ToolCallRequestSchema.safeParse({ name: 'notify_family', arguments: {} }).success).toBe(false);
    expect(ToolCallRequestSchema.safeParse({ name: 'apply_plan', arguments: {} }).success).toBe(false);
  });

  it('answers the MCP CallToolResult a card expects, tool errors included', () => {
    expect(ToolCallReplySchema.safeParse({ content: [{ type: 'text', text: 'Applied.' }], structuredContent: { ok: true } }).success).toBe(true);
    const failed = toolError('plan_expired', 'The plan expired: ask for a new one.');
    expect(ToolCallReplySchema.safeParse({ isError: true, content: [{ type: 'text', text: failed.message }], structuredContent: failed }).success).toBe(true);
    expect(ToolCallReplySchema.safeParse({ content: [] }).success).toBe(false);
  });
});

describe('sandbox homes (#101)', () => {
  it('refuses a home the client may not reach with home_not_allowed as a 403', () => {
    expect(categoryOf('home_not_allowed')).toBe('forbidden');
    const problem = toProblemDetails(toolError('home_not_allowed', 'This client may not reach that home.'), { instance: 'urn:uuid:00000000-0000-4000-8000-000000000000' });
    expect(ProblemDetailsSchema.parse(problem)).toMatchObject({ status: 403, code: 'home_not_allowed' });
  });
});

describe('TurnFailureSchema: an expected turn failure from the agent on AgentCore (#17, G1c, approved in #17)', () => {
  const ID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';

  it('carries the code, its category, the wait time and the turn id, nothing else', () => {
    expect(TurnFailureSchema.parse({ failed: true, code: 'agent_timeout', category: 'dependency_unavailable', retryAfterMs: 2000, correlationId: ID })).toMatchObject({ code: 'agent_timeout' });
    expect(TurnFailureSchema.safeParse({ failed: true, code: 'agent_timeout', category: 'dependency_unavailable', correlationId: ID, message: 'free text' }).success).toBe(false);
  });

  it('refuses a category that is not the catalogue one, and an unknown code', () => {
    expect(TurnFailureSchema.safeParse({ failed: true, code: 'agent_timeout', category: 'internal', correlationId: ID }).success).toBe(false);
    expect(TurnFailureSchema.safeParse({ failed: true, code: 'made_up', category: 'internal', correlationId: ID }).success).toBe(false);
  });

  it('never matches a TurnReply, so the two answers cannot be confused', () => {
    expect(TurnFailureSchema.safeParse({ text: 'Your battery is at 45%.' }).success).toBe(false);
    expect(TurnReplySchema.safeParse({ failed: true, code: 'agent_timeout', category: 'dependency_unavailable', correlationId: ID }).success).toBe(false);
  });
});

describe('speech wire (F8d, #25, approved in #25): a reply spoken by Polly only with its signed ticket', () => {
  const TICKET = 'a'.repeat(43);

  it('lets a turn reply carry the ticket of its own text, and stays valid without it', () => {
    expect(TurnReplySchema.safeParse({ text: 'Your battery is at 64%.', speech: { ticket: TICKET } }).success).toBe(true);
    expect(TurnReplySchema.safeParse({ text: 'Your battery is at 64%.' }).success).toBe(true);
    expect(TurnReplySchema.safeParse({ text: 'Hi.', speech: { ticket: TICKET, voice: 'Matthew' } }).success).toBe(false);
    expect(TurnReplySchema.safeParse({ text: 'Hi.', speech: { ticket: '' } }).success).toBe(false);
  });

  it('asks for speech with exactly the reply text and its ticket: nothing else, no free text beyond a reply', () => {
    expect(SpeechRequestSchema.safeParse({ text: 'Your battery is at 64%.', ticket: TICKET }).success).toBe(true);
    for (const bad of [{ text: '', ticket: TICKET }, { text: 'x'.repeat(601), ticket: TICKET }, { text: 'Hi.' }, { text: 'Hi.', ticket: TICKET, voice: 'Matthew' }, { text: 'Hi.', ticket: 'x'.repeat(257) }]) {
      expect(SpeechRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
});
