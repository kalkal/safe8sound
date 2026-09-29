import type { ControlAvailability, HomeProfile, PacingState, RoomService, Snapshot } from '@cold-reserve/contracts';

export interface StatusDerivation {
  readonly pacing: PacingState;
  readonly controlAvailability: ControlAvailability;
  readonly rooms: readonly RoomService[];
}

export interface StatusDeriverInput {
  readonly snapshot: Snapshot;
  readonly profile: HomeProfile;
  /** The real home is read-only during the hackathon (plan §13.2.1). */
  readonly readOnly: boolean;
  /** Since when the current level holds, while no plan is applied. */
  readonly levelSince: string;
}

/** Port for the parts of the status that need the pacing logic. */
export interface StatusDeriver {
  derive(input: StatusDeriverInput): StatusDerivation;
}

/**
 * TODO(#19): interim derivation, approved in #16. F4 replaces it with the pure
 * level function of core/level (plan §4bis.5), fed by the applied plan and LEVEL#CURRENT.
 * Until then: no plan is ever applied, so the level is the comfort the user chose; a room is served
 * when its split runs, otherwise it waits because the user switched it off. `inverter_limit` and
 * `pacing_level` are never produced here: they need per-room curtailment and the level ladder.
 */
export const interimStatusDeriver: StatusDeriver = {
  derive({ snapshot, profile, readOnly, levelSince }) {
    const units = profile.rooms.flatMap((r) => r.hvacUnits);
    const drivable = units.some((u) => u.controlPath !== 'manual');
    return {
      pacing: { level: 'comfort', levelReason: 'user_choice', levelChangedAt: levelSince },
      controlAvailability: readOnly || !drivable ? 'manual_only' : 'ok',
      rooms: snapshot.rooms.map((room): RoomService =>
        room.hvac !== undefined && room.hvac.mode !== 'off'
          ? { roomId: room.id, state: 'served' }
          : { roomId: room.id, state: 'waiting', waitingReason: 'user_off' },
      ),
    };
  },
};
