// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scriptedDemoSettings } from '../../src/ui/demo-settings.js';
import { useSettingChange } from '../../src/ui/use-setting-change.js';

afterEach(cleanup);

// One demo change at a time (audit of 20 Oct, point 1; review of #484): two taps in the same instant, before React
// draws again, send one change; the next one goes once the first has ended, whatever its end.

describe('useSettingChange', () => {
  it('drops a second change sent in the same instant, and takes the next one after the first ended', async () => {
    let done: (saved: boolean) => void = () => undefined;
    const onChange = vi.fn(() => new Promise<boolean>((resolve) => { done = resolve; }));
    const { result } = renderHook(() => useSettingChange(onChange, scriptedDemoSettings()));
    act(() => {
      result.current.send({ locationId: 'turin' }, { name: 'place', value: 'turin' });
      result.current.send({ locationId: 'houston' }, { name: 'place', value: 'houston' });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);
    await act(async () => { done(false); await Promise.resolve(); });
    expect(result.current.busy).toBe(false);
    act(() => {
      result.current.send({ locationId: 'houston' }, { name: 'place', value: 'houston' });
    });
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
