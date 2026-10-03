import { StormDeviceSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createSimulatedDevices, demoProfile } from '../src/index.js';

const mower = StormDeviceSchema.parse({ entityId: 'lawn_mower.garden', domain: 'lawn_mower' });

describe('simulated devices (queue item 7: the only DeviceAdapter there is)', () => {
  it('docks and closes in the simulation, and remembers what it did', async () => {
    const devices = createSimulatedDevices();
    expect(await devices.adapter.secure(mower)).toEqual({ ok: true, value: undefined });
    expect(devices.secured()).toEqual(['lawn_mower.garden']);
  });

  it('can be told to fail a device, for the fault-injection tests', async () => {
    const devices = createSimulatedDevices({ failing: ['lawn_mower.garden'] });
    expect(await devices.adapter.secure(mower)).toMatchObject({ ok: false, error: { code: 'device_unreachable' } });
    expect(devices.secured()).toEqual([]);
  });

  it('the demo home has a mower and a shutter to make safe', () => {
    expect(demoProfile().stormDevices?.map((d) => d.entityId)).toEqual(['lawn_mower.garden', 'cover.living_room']);
  });
});
