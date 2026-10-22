import { StatusFactsSchema, err, ok, toolError, type ErrorCode } from '@cold-reserve/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/agent/agent.js';
import { withScriptedFallback } from '../src/agent/fallback-agent.js';

// These agents only answer; tool calls are covered in agent-tools.test.ts.
const noTool = () => Promise.reject(new Error('not used here'));

const scripted: Agent = { canCallTools: false, callTool: noTool, ask: () => Promise.resolve(ok({ text: 'Scripted answer.' })) };
const failing = (code: ErrorCode): Agent => ({ canCallTools: false, callTool: noTool, ask: () => Promise.resolve(err(toolError(code, 'Failed.'))) });
const ctx = { correlationId: 'c' };

describe('degraded mode: RemoteAgent down → scripted answer + notice (error-handling §5)', () => {
  it('passes a remote answer through untouched', async () => {
    const remote: Agent = { canCallTools: false, callTool: noTool, ask: () => Promise.resolve(ok({ text: 'Remote answer.' })) };
    expect(await withScriptedFallback(remote, scripted).ask('q', ctx)).toEqual(ok({ text: 'Remote answer.' }));
  });

  it.each<ErrorCode>(['agent_unavailable', 'output_schema_violation'])(
    'answers from the script and says why when the remote fails with %s',
    async (code) => {
      expect(await withScriptedFallback(failing(code), scripted).ask('q', ctx)).toEqual(ok({ text: 'Scripted answer.', degradedBy: code }));
    },
  );

  it('does not hide a slow turn behind the script: agent_timeout reaches the user as it is, with its own message (#270)', async () => {
    const log = vi.fn();
    const result = await withScriptedFallback(failing('agent_timeout'), scripted, log).ask('q', ctx);
    expect(result).toMatchObject({ ok: false, error: { code: 'agent_timeout' } });
    expect(log).not.toHaveBeenCalled();
  });

  it('does not hide a quota or permission error behind the script', async () => {
    const result = await withScriptedFallback(failing('demo_quota_exceeded'), scripted).ask('q', ctx);
    expect(result).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded' } });
  });

  it('keeps the offline-example mark of a scripted reading: a fixed figure never looks live (option B, 20 Oct)', async () => {
    const status = StatusFactsSchema.parse({ batterySocPct: 78, origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' }, ts: '2026-07-18T12:00:00+02:00' });
    const reading: Agent = { canCallTools: false, callTool: noTool, ask: () => Promise.resolve(ok({ text: 'At 78%.', status, example: true })) };
    expect(await withScriptedFallback(failing('agent_unavailable'), reading).ask('q', ctx)).toEqual(ok({ text: 'At 78%.', status, example: true, degradedBy: 'agent_unavailable' }));
  });

  it('never passes cards from the script through the degraded mode', async () => {
    const withCard: Agent = { canCallTools: false, callTool: noTool, ask: () => Promise.resolve(ok({ text: 'Scripted.', cards: [{ tool: 'invalid' as const }] })) };
    const result = await withScriptedFallback(failing('agent_unavailable'), withCard).ask('q', ctx);
    expect(result).toEqual(ok({ text: 'Scripted.', degradedBy: 'agent_unavailable' }));
  });
});

describe('degraded mode is logged with the turn correlation id (audit L6)', () => {
  it('logs the failure it replaces', async () => {
    const log = vi.fn();
    await withScriptedFallback(failing('agent_unavailable'), scripted, log).ask('q', { correlationId: 'turn-7' });
    expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'warn', code: 'agent_unavailable', correlationId: 'turn-7', details: { degraded: true } });
  });

  it('logs a failure the script could not replace either', async () => {
    const log = vi.fn();
    await withScriptedFallback(failing('agent_unavailable'), failing('invalid_config'), log).ask('q', { correlationId: 'turn-8' });
    expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'error', code: 'agent_unavailable', correlationId: 'turn-8', details: { degraded: false, fallbackCode: 'invalid_config' } });
  });

  it('logs nothing for an answer or an error the user sees as it is', async () => {
    const log = vi.fn();
    await withScriptedFallback(scripted, scripted, log).ask('q', ctx);
    await withScriptedFallback(failing('demo_quota_exceeded'), scripted, log).ask('q', ctx);
    expect(log).not.toHaveBeenCalled();
  });
});
