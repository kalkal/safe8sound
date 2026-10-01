import { safeRoomInStorm } from '@cold-reserve/ui-cards';
import { describe, expect, it } from 'vitest';
import { readCards } from '../../src/agent/wire.js';
import { kindOf } from '../../src/host/CardFrame.js';

describe('kindOf: which card shows a tool result', () => {
  it('maps each card tool to its own kind, the safe room included', () => {
    expect(kindOf('plan_comfort')).toBe('plan');
    expect(kindOf('apply_plan')).toBe('applied');
    expect(kindOf('get_safe_room_status')).toBe('storm');
  });

  it('never shows another card for a tool without one: no kind, so the frame says the card failed', () => {
    expect(kindOf('notify_family')).toBeUndefined();
    expect(kindOf('surprise')).toBeUndefined();
  });
});

describe('the wire carries the safe-room card', () => {
  it('validates get_safe_room_status by its contract, and refuses a broken one calmly', () => {
    expect(readCards([{ tool: 'get_safe_room_status', result: safeRoomInStorm() }])).toEqual([{ tool: 'get_safe_room_status', result: safeRoomInStorm() }]);
    expect(readCards([{ tool: 'get_safe_room_status', result: { safeRoomId: 'bedroom-1' } }])).toEqual([{ tool: 'invalid' }]);
  });
});
