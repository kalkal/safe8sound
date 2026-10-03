import { SECURE_ACTION, type DeviceAdvice, type DeviceSecured, type ErrorCode, type ErrorEnvelope, type FamilyReply, type Result, type StormDevice } from '@cold-reserve/contracts';
import { causeFields } from './logger.js';

// Queue items 3 and 7 (approved in #24), pure: making the house safe before a storm, and the rate
// limit on the family's replies. Only a simulated DeviceAdapter exists; the real home gets advice.

/** Port of the devices made safe: lawn_mower.dock, cover.close_cover. The only adapter is simulated. */
export interface DeviceAdapter {
  readonly secure: (device: StormDevice) => Promise<Result<void, ErrorEnvelope>>;
}

export interface DevicePrep {
  readonly secured: DeviceSecured[];
  /** On the read-only home: what to do by hand; the adapter is never called (plan §13.2 p.1). */
  readonly advice: DeviceAdvice[];
  /** Why each failed device failed, for the log line: the adapter's code, never its text. */
  readonly failures: DeviceFailure[];
}

export interface DeviceFailure {
  readonly entityId: string;
  readonly code: ErrorCode;
  /** Only when the adapter threw: the error's name (a thrown error is a bug, `unexpected_error`). */
  readonly errorName?: string;
}

export async function prepareDevices(input: { devices: readonly StormDevice[]; adapter: DeviceAdapter; readOnly: boolean; at: string }): Promise<DevicePrep> {
  if (input.readOnly) {
    return { secured: [], advice: input.devices.map((d) => ({ domain: d.domain, action: SECURE_ACTION[d.domain] })), failures: [] };
  }
  const secured: DeviceSecured[] = [];
  const failures: DeviceFailure[] = [];
  // One device at a time: a slow cover never races a mower, and the order of the list is the order of the voice.
  for (const device of input.devices) {
    const failure = await secureOne(input.adapter, device);
    if (failure !== undefined) failures.push(failure);
    secured.push({ entityId: device.entityId, domain: device.domain, action: SECURE_ACTION[device.domain], outcome: failure === undefined ? 'done' : 'failed', at: input.at });
  }
  return { secured, advice: [], failures };
}

/**
 * A device that fails or throws is a failed device: the others still run and the storm is not blocked.
 * The cause is kept as a value (its code, or the thrown error's name) for the caller's log line.
 */
async function secureOne(adapter: DeviceAdapter, device: StormDevice): Promise<DeviceFailure | undefined> {
  try {
    const result = await adapter.secure(device);
    return result.ok ? undefined : { entityId: device.entityId, code: result.error.code };
  } catch (cause) {
    return { entityId: device.entityId, code: 'unexpected_error', errorName: causeFields(cause, { withStack: false }).errorName };
  }
}

/** A role may reply again only after the interval (anti-spam on the phone route). */
export function replyAllowed(input: { replies: readonly FamilyReply[]; role: string; nowMs: number; minIntervalSeconds: number }): boolean {
  return !input.replies.some((r) => r.role === input.role && input.nowMs - Date.parse(r.at) < input.minIntervalSeconds * 1000);
}
