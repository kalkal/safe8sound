import type { SetScenarioInput } from '@cold-reserve/contracts';
import { useCallback, useState } from 'react';
import type { DemoSettingsView } from './demo-settings.js';
import { t } from './text.js';

/**
 * A choice of the demo (scenario, place, household, units, restart) says what happened (owner, 18 Oct): the tapped row
 * is chosen at once with "Saving…", then a line says what the demo plays now, or that it was not saved. Shared by the
 * judges' demo controls and the settings drawer.
 */
export function useSettingChange(onChange: (change: SetScenarioInput) => Promise<boolean>, settings: DemoSettingsView | undefined) {
  const [pick, setPick] = useState<{ name: string; value: string } | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [applied, setApplied] = useState<'saved' | 'restarted' | 'failed' | undefined>(undefined);
  const send = useCallback(
    (change: SetScenarioInput, picked?: { name: string; value: string }) => {
      setPick(picked);
      setSending(true);
      setApplied(undefined);
      void onChange(change).then((saved) => {
        setSending(false);
        setPick(undefined);
        setApplied(saved ? (change.restart === true ? 'restarted' : 'saved') : 'failed');
      });
    },
    [onChange],
  );
  const pendingOf = (name: string) => (pick?.name === name ? pick.value : undefined);
  const appliedText =
    sending ? t('settings.saving')
    : applied === 'failed' ? t('settings.failed')
    : applied !== undefined && settings !== undefined
      ? t(applied === 'restarted' ? 'settings.restarted' : 'settings.applied', { place: t(`settings.place.${settings.locationId}`), scenario: t(`settings.scenario.${settings.scenarioId}`) })
      : '';
  const forget = useCallback(() => {
    setApplied(undefined);
  }, []);
  return { send, pendingOf, appliedText, failed: applied === 'failed', forget };
}
