import { StormDeviceSchema, err, ok, toolError, type FamilyReply, type StormDevice } from '@cold-reserve/contracts';
import { describe, expect, it, vi } from 'vitest';
import { prepareDevices, replyAllowed, type DeviceAdapter } from '../src/storm-prep.js';

const mower = StormDeviceSchema.parse({ entityId: 'lawn_mower.garden', domain: 'lawn_mower' });
const shutter = StormDeviceSchema.parse({ entityId: 'cover.living', domain: 'cover' });
const AT = '2026-07-18T19:00:00Z';

const adapter = (fail: (d: StormDevice) => boolean = () => false): DeviceAdapter & { secure: ReturnType<typeof vi.fn> } => ({
  secure: vi.fn((d: StormDevice) => Promise.resolve(fail(d) ? err(toolError('device_unreachable', 'No answer.')) : ok(undefined))),
});

describe('prepareDevices (queue item 7: the house gets ready for the storm)', () => {
  it('docks the mower and closes the shutters, recording each outcome', async () => {
    const a = adapter((d) => d.domain === 'cover');
    const out = await prepareDevices({ devices: [mower, shutter], adapter: a, readOnly: false, at: AT });
    expect(out.secured).toEqual([
      { entityId: 'lawn_mower.garden', domain: 'lawn_mower', action: 'dock', outcome: 'done', at: AT },
      { entityId: 'cover.living', domain: 'cover', action: 'close', outcome: 'failed', at: AT },
    ]);
    expect(out.advice).toEqual([]);
    // The cause is kept for the log line: the adapter's code, never its text (#172 review).
    expect(out.failures).toEqual([{ entityId: 'cover.living', code: 'device_unreachable' }]);
  });

  it('on the real home never calls the adapter: it only advises (plan §13.2 p.1)', async () => {
    const a = adapter();
    const out = await prepareDevices({ devices: [mower, shutter], adapter: a, readOnly: true, at: AT });
    expect(a.secure).not.toHaveBeenCalled();
    expect(out.secured).toEqual([]);
    expect(out.failures).toEqual([]);
    expect(out.advice).toEqual([
      { domain: 'lawn_mower', action: 'dock' },
      { domain: 'cover', action: 'close' },
    ]);
  });

  it('a device that throws is recorded as failed, and the others still run', async () => {
    const a: DeviceAdapter = { secure: (d) => (d.domain === 'lawn_mower' ? Promise.reject(new Error('boom')) : Promise.resolve(ok(undefined))) };
    const out = await prepareDevices({ devices: [mower, shutter], adapter: a, readOnly: false, at: AT });
    expect(out.secured.map((s) => s.outcome)).toEqual(['failed', 'done']);
    expect(out.failures).toEqual([{ entityId: 'lawn_mower.garden', code: 'unexpected_error', errorName: 'Error' }]);
  });

  it('with no devices does nothing', async () => {
    const a = adapter();
    expect(await prepareDevices({ devices: [], adapter: a, readOnly: false, at: AT })).toEqual({ secured: [], advice: [], failures: [] });
  });
});

describe('replyAllowed (a phone reply at most every 30 s per role)', () => {
  const reply = (role: string, at: string): FamilyReply => ({ role, reply: 'on_my_way', at });
  const now = Date.parse('2026-07-18T21:30:30Z');

  it('lets a first reply through, and the next one from the same role only after the interval', () => {
    expect(replyAllowed({ replies: [], role: 'daughter', nowMs: now, minIntervalSeconds: 30 })).toBe(true);
    expect(replyAllowed({ replies: [reply('daughter', '2026-07-18T21:30:01Z')], role: 'daughter', nowMs: now, minIntervalSeconds: 30 })).toBe(false);
    expect(replyAllowed({ replies: [reply('daughter', '2026-07-18T21:30:00Z')], role: 'daughter', nowMs: now, minIntervalSeconds: 30 })).toBe(true);
  });

  it('counts each role on its own', () => {
    expect(replyAllowed({ replies: [reply('son', '2026-07-18T21:30:20Z')], role: 'daughter', nowMs: now, minIntervalSeconds: 30 })).toBe(true);
  });
});
