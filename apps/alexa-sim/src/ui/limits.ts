import {
  ELDERLY_CAP_MAX_C,
  PublicPreferencesSchema,
  HEAT_INDEX_CAP_MAX_C,
  effectiveHeatSafety,
  type GetPreferencesOutput,
  type PublicPreferences,
  type SetPreferencesInput,
} from '@cold-reserve/contracts';
import { withSafeRoom } from '@cold-reserve/ui-cards';
import guard from '@cold-reserve/guard/config/guard.json' with { type: 'json' };

// #402: the temperatures and limits of the settings section. Every value and bound is read from the preferences, their
// hard limits (config) and the guard config; the rules are the ones the server plays (#266, #307): the comfort
// temperature stays between the heating comfort and the safe room maximum; the safe room maximum stays in its
// configured range; the health caps can only be made stricter. A move that breaks a rule is refused here, in words, before anything is sent.

export type LimitId = 'comfort' | 'safeMax' | 'heatIndexCap' | 'elderlyCap';

export interface LimitRow {
  id: LimitId;
  valueC: number;
  /** The lowest the row may go. */
  minC: number;
  /** The highest. For a limit that guards health this is where it starts: it can only go down from here. */
  maxC: number;
}

export interface LimitsView {
  rows: LimitRow[];
  /** The night limit applies to every plan (#266), not only to the last resort. */
  nightEveryPlan: boolean;
  /** The night health limits of the guard config, shown with their sources. */
  night: { standardC: number; elderlyC: number };
}

/** The same half-degree step as the Preferences card. */
export const LIMIT_STEP_C = 0.5;

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function limitsView(view: GetPreferencesOutput): LimitsView {
  const { preferences, hardLimits } = view;
  const heat = effectiveHeatSafety(preferences.safety);
  const safeMax = hardLimits.cooling.maxC;
  const rows: LimitRow[] = [
    { id: 'comfort', valueC: preferences.comfortC.cooling, minC: preferences.comfortC.heating, maxC: preferences.safety.cooling.maxC },
    // The range the owner approved (config, like the Preferences card): not under the comfort temperature.
    { id: 'safeMax', valueC: preferences.safety.cooling.maxC, minC: Math.max(safeMax.min, preferences.comfortC.cooling), maxC: safeMax.max },
  ];
  const heatBound = hardLimits.heatIndexCapC;
  if (heatBound !== undefined) rows.push({ id: 'heatIndexCap', valueC: heat.heatIndexCapC, minC: heatBound.min, maxC: Math.min(heatBound.max, HEAT_INDEX_CAP_MAX_C) });
  const elderlyBound = hardLimits.elderlyCapC;
  if (elderlyBound !== undefined) rows.push({ id: 'elderlyCap', valueC: heat.elderlyCapC, minC: elderlyBound.min, maxC: Math.min(elderlyBound.max, ELDERLY_CAP_MAX_C) });
  return {
    rows,
    nightEveryPlan: heat.stricterNightLimit,
    night: { standardC: guard.nightRecovery.thresholdC.standard, elderlyC: guard.nightRecovery.thresholdC.elderly },
  };
}

export type LimitRefusal =
  /** A limit that guards health may only be made stricter. */
  | { kind: 'looser'; limitC: number }
  /** Above the highest the configuration allows. */
  | { kind: 'ceiling'; limitC: number }
  /** Under the lowest allowed. */
  | { kind: 'floor'; limitC: number }
  /** The comfort temperature cannot pass the safe room maximum. */
  | { kind: 'comfortAboveMax'; limitC: number }
  /** The safe room maximum cannot go under the comfort temperature. */
  | { kind: 'safeBelowComfort'; limitC: number };

export type LimitChange = Omit<SetPreferencesInput, 'confirmed'>;
/** How a Save of the limits ended: `rate_limited` is the demo's daily limit of changes. */
export type LimitSave = 'saved' | 'rate_limited' | 'failed';
export type LimitMove = { ok: true; change: LimitChange } | { ok: false; refusal: LimitRefusal };

function changeOf(id: LimitId, valueC: number): LimitChange {
  switch (id) {
    case 'comfort':
      return { comfortC: { cooling: valueC } };
    case 'safeMax':
      return { safety: { cooling: { maxC: valueC } } };
    case 'heatIndexCap':
      return { safety: { heatIndexCapC: valueC } };
    case 'elderlyCap':
      return { safety: { elderlyCapC: valueC } };
  }
}

/** One step up or down on a row: the change to send, or the rule that says no. */
export function moveLimit(view: GetPreferencesOutput, id: LimitId, direction: 'up' | 'down'): LimitMove {
  const row = limitsView(view).rows.find((r) => r.id === id);
  if (row === undefined) return { ok: false, refusal: { kind: 'floor', limitC: view.preferences.safety.cooling.maxC } };
  const next = round1(row.valueC + (direction === 'up' ? LIMIT_STEP_C : -LIMIT_STEP_C));
  if (direction === 'up' && next > row.maxC) return { ok: false, refusal: { kind: id === 'comfort' ? 'comfortAboveMax' : id === 'safeMax' ? 'ceiling' : 'looser', limitC: row.maxC } };
  if (direction === 'down' && next < row.minC) {
    const underComfort = id === 'safeMax' && row.minC === view.preferences.comfortC.cooling && row.minC > view.hardLimits.cooling.maxC.min;
    return { ok: false, refusal: { kind: underComfort ? 'safeBelowComfort' : 'floor', limitC: row.minC } };
  }
  return { ok: true, change: changeOf(id, next) };
}

/** The view after the home stored a change: what is shown is what is stored. */
export function withSaved(view: GetPreferencesOutput, saved: PublicPreferences): GetPreferencesOutput {
  return { ...view, preferences: saved, isDefault: false };
}

/** Another safe room, the Preferences card's way (same rule, ui-cards): it leads the room priority. Nothing to send for the same room or an unknown one. */
export function chooseSafeRoom(view: GetPreferencesOutput, roomId: string): { ok: true; change: LimitChange } | { ok: false } {
  const { safeRoomId, roomPriority } = view.preferences;
  if (roomId === safeRoomId || !roomPriority.includes(roomId)) return { ok: false };
  const next = withSafeRoom({ safeRoomId, roomPriority }, roomId);
  return { ok: true, change: { safeRoomId: next.safeRoomId, roomPriority: [...next.roomPriority] } };
}

type Safety = NonNullable<LimitChange['safety']>;

/** Two changes of the same draft as one: the later value of a field wins; what was not touched is not sent. */
export function mergeChange(a: LimitChange, b: LimitChange): LimitChange {
  const cooling = b.safety?.cooling ?? a.safety?.cooling;
  const safety: Safety = { ...a.safety, ...b.safety, ...(cooling === undefined ? {} : { cooling }) };
  const comfortC = b.comfortC === undefined && a.comfortC === undefined ? undefined : { ...a.comfortC, ...b.comfortC };
  return {
    ...(comfortC === undefined ? {} : { comfortC }),
    ...(b.safeRoomId === undefined && a.safeRoomId === undefined ? {} : { safeRoomId: b.safeRoomId ?? a.safeRoomId }),
    ...(b.roomPriority === undefined && a.roomPriority === undefined ? {} : { roomPriority: b.roomPriority ?? a.roomPriority }),
    ...(Object.keys(safety).length === 0 ? {} : { safety }),
  };
}

/** The view with a draft change on it, to show what Save would store; the contract re-brands every value. */
export function withDraft(view: GetPreferencesOutput, change: LimitChange): GetPreferencesOutput {
  const p = view.preferences;
  const next = PublicPreferencesSchema.safeParse({
    ...p,
    comfortC: { ...p.comfortC, ...change.comfortC },
    safeRoomId: change.safeRoomId ?? p.safeRoomId,
    roomPriority: change.roomPriority ?? p.roomPriority,
    safety: { ...p.safety, ...change.safety, cooling: { maxC: change.safety?.cooling?.maxC ?? p.safety.cooling.maxC } },
  });
  return next.success ? { ...view, preferences: next.data } : view;
}

/** Whether a draft changes any saved value (review of #469): a step down and back up leaves nothing to save. */
export function changesAnything(view: GetPreferencesOutput, change: LimitChange): boolean {
  return JSON.stringify(withDraft(view, change).preferences) !== JSON.stringify(withDraft(view, {}).preferences);
}
