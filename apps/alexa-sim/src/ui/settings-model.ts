import type { GetPreferencesOutput, SetScenarioInput, TempUnit } from '@cold-reserve/contracts';
import { useCallback, useState } from 'react';
import type { DemoSettingsView } from './demo-settings.js';
import { chooseSafeRoom, limitsView, mergeChange, moveLimit, withDraft, type LimitChange, type LimitId, type LimitRefusal, type LimitSave, type LimitsView } from './limits.js';
import { useSettingChange } from './use-setting-change.js';

// The person's own settings as one model (#432 S5): the saved preferences with the unsaved draft on them, the unit
// choice and what each save said. It lives once, above every view of the settings (the Echo's page, Ana's phone), so
// both show the same data and the same draft, and the draft outlives a closed page ("Not saved yet" when it comes back).

export interface SettingsModelInput {
  /** The sandbox's settings; undefined when there are none (not a sandbox, or not read yet): language only (#284). */
  settings: DemoSettingsView | undefined;
  /** Sends one change (the units); resolves true when it was saved. */
  onChange: (change: SetScenarioInput) => Promise<boolean>;
  /** #402: the home's preferences with their limits; undefined until read. */
  limits: GetPreferencesOutput | undefined;
  /** Saves the draft as one change (the Preferences card's tool): how it ended. */
  onLimit: ((change: LimitChange) => Promise<LimitSave>) | undefined;
}

export function useSettingsModel({ settings, onChange, limits, onLimit }: SettingsModelInput) {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  // #402: why a move was not made, said in words under the rows.
  const [refusal, setRefusal] = useState<{ id: LimitId; why: LimitRefusal } | undefined>(undefined);
  // #402: the +/- and the choices change a draft; Save sends it as one write.
  const [draft, setDraft] = useState<LimitChange>({});
  const unit = useSettingChange(onChange, settings);

  const units: TempUnit = settings?.units ?? 'C';
  // What the views show: the saved preferences with the draft on them.
  const shown = limits === undefined ? undefined : withDraft(limits, draft);
  const view: LimitsView | undefined = shown === undefined ? undefined : limitsView(shown);
  const dirty = Object.keys(draft).length > 0;

  const addToDraft = (change: LimitChange) => {
    setRateLimited(false);
    setDraft((previous) => mergeChange(previous, change));
  };
  const save = () => {
    if (!dirty || saving) return;
    setSaving(true);
    setFailed(false);
    setRateLimited(false);
    void (onLimit?.(draft) ?? Promise.resolve<LimitSave>('failed')).then((saved) => {
      setSaving(false);
      if (saved === 'saved') setDraft({});
      setFailed(saved === 'failed');
      setRateLimited(saved === 'rate_limited');
    });
  };
  const move = (id: LimitId, direction: 'up' | 'down') => {
    if (shown === undefined) return;
    const result = moveLimit(shown, id, direction);
    setRefusal(result.ok ? undefined : { id, why: result.refusal });
    if (result.ok) addToDraft(result.change);
  };
  const pickSafeRoom = (roomId: string) => {
    if (shown === undefined) return;
    const chosen = chooseSafeRoom(shown, roomId);
    if (chosen.ok) addToDraft(chosen.change);
  };
  const toggleNightEveryPlan = () => {
    if (view !== undefined) addToDraft({ safety: { stricterNightLimit: !view.nightEveryPlan } });
  };
  const pickUnits = (value: string) => {
    unit.send({ units: value === 'F' ? 'F' : 'C' }, { name: 'units', value });
  };
  const { forget } = unit;
  // A page that closes forgets what its last tap said; the draft stays.
  const leave = useCallback(() => {
    setRefusal(undefined);
    forget();
  }, [forget]);
  const status = saving ? 'saving' : failed ? 'failed' : rateLimited ? 'rateLimited' : dirty ? 'unsaved' : undefined;

  return {
    settings,
    units,
    shown,
    view,
    dirty,
    saving,
    status,
    refusal,
    unitPending: unit.pendingOf('units'),
    unitText: unit.appliedText,
    unitFailed: unit.failed,
    move,
    pickSafeRoom,
    toggleNightEveryPlan,
    pickUnits,
    save,
    leave,
  } as const;
}

export type SettingsModel = ReturnType<typeof useSettingsModel>;
