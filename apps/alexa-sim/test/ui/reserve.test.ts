import { ReserveOutlookSchema, SafeRoomStatusSchema } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { safeRoomCalm } from '@cold-reserve/ui-cards';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../../src/agent/agent.js';
import type { LogEvent } from '../../src/log.js';
import { fetchReserve, fetchSafeRoom } from '../../src/ui/reserve.js';

// The idle screen's own readings (owner, 11 Oct; #432 S6): the ice cubes of the reserve (get_reserve_outlook) and
// Leo's room (get_safe_room_status), each read through the same call. A failure is a quiet degraded mode (no tile, no
// broken screen) with one structured log line naming its step.

const ctx = { correlationId: 'c-reserve' };
const outlook = ReserveOutlookSchema.parse(exampleReserveOutlook());
const room = SafeRoomStatusSchema.parse(safeRoomCalm());
const agentWith = (result: unknown, calls: string[] = []) =>
  ({
    canCallTools: true,
    ask: () => Promise.reject(new Error('unused')),
    callTool: (name: string) => {
      calls.push(name);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  }) as unknown as Agent;

const READINGS = [
  { read: fetchReserve, tool: 'get_reserve_outlook', step: 'reserve_clock', value: outlook as unknown },
  { read: fetchSafeRoom, tool: 'get_safe_room_status', step: 'safe_room_tile', value: room as unknown },
] as const;

describe.each(READINGS)('$tool', ({ read, tool, step, value }) => {
  it('reads what the tool returned, as the contract parses it', async () => {
    const calls: string[] = [];
    const reply = { content: [{ type: 'text', text: 'x' }], structuredContent: value };
    expect(await read(agentWith(reply, calls), ctx, () => undefined)).toEqual({ ok: true, value });
    expect(calls).toEqual([tool]);
  });

  it('a refused call, a result that breaks the contract or a call that throws is a failure, logged once with the turn id', async () => {
    const cases: unknown[] = [
      { isError: true, content: [{ type: 'text', text: 'Only card actions can be called here.' }], structuredContent: { code: 'invalid_input' } },
      { content: [{ type: 'text', text: 'x' }], structuredContent: { hoursAtCurrentLevel: 'many', safeUntil: 7 } },
      new Error('network'),
    ];
    for (const result of cases) {
      const lines: LogEvent[] = [];
      expect(await read(agentWith(result), ctx, (e) => lines.push(e))).toMatchObject({ ok: false });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'warn', correlationId: 'c-reserve', details: { step } });
      // Never the sandbox: no home id in the line.
      expect(JSON.stringify(lines[0])).not.toMatch(/demo#|homeId/);
    }
  });
});
