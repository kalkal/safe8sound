import { err, ok, toolError, type ErrorCode } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/agent/agent.js';
import { withScriptedFallback } from '../src/agent/fallback-agent.js';

const scripted: Agent = { ask: () => Promise.resolve(ok({ text: 'Scripted answer.' })) };
const failing = (code: ErrorCode): Agent => ({ ask: () => Promise.resolve(err(toolError(code, 'Failed.'))) });
const ctx = { correlationId: 'c' };

describe('degraded mode: RemoteAgent down → scripted answer + notice (error-handling §5)', () => {
  it('passes a remote answer through untouched', async () => {
    const remote: Agent = { ask: () => Promise.resolve(ok({ text: 'Remote answer.' })) };
    expect(await withScriptedFallback(remote, scripted).ask('q', ctx)).toEqual(ok({ text: 'Remote answer.' }));
  });

  it.each<ErrorCode>(['agent_timeout', 'agent_unavailable', 'output_schema_violation'])(
    'answers from the script and says why when the remote fails with %s',
    async (code) => {
      expect(await withScriptedFallback(failing(code), scripted).ask('q', ctx)).toEqual(ok({ text: 'Scripted answer.', degradedBy: code }));
    },
  );

  it('does not hide a quota or permission error behind the script', async () => {
    const result = await withScriptedFallback(failing('demo_quota_exceeded'), scripted).ask('q', ctx);
    expect(result).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded' } });
  });

  it('never passes cards from the script through the degraded mode', async () => {
    const withCard: Agent = { ask: () => Promise.resolve(ok({ text: 'Scripted.', cards: [{ tool: 'invalid' as const }] })) };
    const result = await withScriptedFallback(failing('agent_unavailable'), withCard).ask('q', ctx);
    expect(result).toEqual(ok({ text: 'Scripted.', degradedBy: 'agent_unavailable' }));
  });
});
