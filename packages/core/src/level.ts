import type { Level, PacingState } from '@cold-reserve/contracts';

// The pacing level as a pure function (plan §4bis.4-5, §9.4): of the confirmed ladder, the SOC against
// the plan's trajectory, the time and the previous level. Hysteresis: a step down needs the SOC below
// the track by `downMarginPct`, a step back up needs it above by `upMarginPct` and `minDwellMinutes` at
// the current level; any change needs fewer than `maxChangesPerHour` changes in the last hour.
// Reasons: `soc_below_track` down, `soc_above_track` back up, `user_choice` back at the top of the ladder.
// One rung at a time, and never outside the ladder the person confirmed.

export interface PacingConfig {
  readonly downMarginPct: number;
  readonly upMarginPct: number;
  readonly maxChangesPerHour: number;
  readonly minDwellMinutes: number;
}

export interface LevelInput {
  readonly current: PacingState;
  /** The confirmed ladder, from its top level down. */
  readonly ladder: readonly Level[];
  readonly socPct: number;
  /** SOC the plan expects now. */
  readonly trackSocPct: number;
  readonly nowMs: number;
  /** When the level changed recently (epoch ms). */
  readonly recentChangesMs: readonly number[];
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** The next pacing state; the same object when nothing changes, so callers can compare by reference. */
export function nextLevel(input: LevelInput, cfg: PacingConfig): PacingState {
  const { current, ladder } = input;
  const index = ladder.indexOf(current.level);
  const changesInHour = input.recentChangesMs.filter((ms) => ms > input.nowMs - HOUR_MS && ms <= input.nowMs).length;
  if (index < 0 || changesInHour >= cfg.maxChangesPerHour) return current;

  const levelChangedAt = new Date(input.nowMs).toISOString();
  const below = input.socPct < input.trackSocPct - cfg.downMarginPct;
  const lower = ladder[index + 1];
  if (below && lower !== undefined) return { level: lower, levelReason: 'soc_below_track', levelChangedAt };

  const above = input.socPct > input.trackSocPct + cfg.upMarginPct;
  const dwelled = input.nowMs - Date.parse(current.levelChangedAt) >= cfg.minDwellMinutes * MINUTE_MS;
  const higher = ladder[index - 1];
  if (above && dwelled && higher !== undefined) {
    return { level: higher, levelReason: index - 1 === 0 ? 'user_choice' : 'soc_above_track', levelChangedAt };
  }
  return current;
}
