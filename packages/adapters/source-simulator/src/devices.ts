import { err, ok, toolError } from '@cold-reserve/contracts';
import type { DeviceAdapter } from '@cold-reserve/core';

/**
 * The only DeviceAdapter (queue item 7, approved in #24): the simulated house docks its mower and closes
 * its shutters. Nothing real is ever called; the real home gets advice instead (plan §13.2 p.1).
 */
export interface SimulatedDevices {
  readonly adapter: DeviceAdapter;
  /** The entities made safe so far, in order. */
  readonly secured: () => string[];
}

export function createSimulatedDevices(options: { failing?: readonly string[] } = {}): SimulatedDevices {
  const done: string[] = [];
  const failing = new Set(options.failing ?? []);
  return {
    adapter: {
      secure: (device) => {
        if (failing.has(device.entityId)) {
          return Promise.resolve(err(toolError('device_unreachable', `${device.entityId} did not answer.`)));
        }
        done.push(device.entityId);
        return Promise.resolve(ok(undefined));
      },
    },
    secured: () => [...done],
  };
}
