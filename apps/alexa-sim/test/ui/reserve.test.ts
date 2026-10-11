import { ReserveOutlookSchema } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../../src/agent/agent.js';
import type { LogEvent } from '../../src/log.js';
import { fetchReserve } from '../../src/ui/reserve.js';

// The cold reserve clock on the idle screen (owner, 11 Oct): the ice cubes of the reserve, read with
// get_reserve_outlook. A failure is a quiet degraded mode (no cubes, no broken screen) with one structured log line.

const ctx = { correlationId: 'c-reserve' };
const outlook = ReserveOutlookSchema.parse(exampleReserveOutlook());
const agentWith = (result: unknown) =>
  ({ canCallTools: true, ask: () => Promise.reject(new Error('unused')), callTool: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) }) as unknown as Agent;

describe('fetchReserve', () => {
  it('reads the outlook the tool returned, as the contract parses it', async () => {
    const reply = { content: [{ type: 'text', text: 'Reserve.' }], structuredContent: outlook };
    expect(await fetchReserve(agentWith(reply), ctx, () => undefined)).toEqual({ ok: true, value: outlook });
  });

  it('a refused call, a result that breaks the contract or a call that throws is a failure, logged once with the turn id', async () => {
    const cases: unknown[] = [
      { isError: true, content: [{ type: 'text', text: 'Only card actions can be called here.' }], structuredContent: { code: 'invalid_input' } },
      { content: [{ type: 'text', text: 'x' }], structuredContent: { hoursAtCurrentLevel: 'many' } },
      new Error('network'),
    ];
    for (const result of cases) {
      const lines: LogEvent[] = [];
      expect(await fetchReserve(agentWith(result), ctx, (e) => lines.push(e))).toMatchObject({ ok: false });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'warn', correlationId: 'c-reserve', details: { step: 'reserve_clock' } });
      // Never the sandbox: no home id in the line.
      expect(JSON.stringify(lines[0])).not.toMatch(/demo#|homeId/);
    }
  });
});
