import type { ErrorEnvelope, SetScenarioInput } from '@cold-reserve/contracts';
import { useCallback, useRef, useState } from 'react';
import { closedNoticeOf, type DemoSettingsView } from './demo-settings.js';
import { t } from './text.js';

/** How a change ended: stored, or not (`false`, or the error when the caller has it: the day's quota says so). */
export type SettingChangeResult = boolean | ErrorEnvelope;

/**
 * A choice of the demo (scenario, place, household, units, restart) says what happened (owner, 18 Oct): the tapped row
 * is chosen at once with "Saving…", then a line says what the demo plays now, or that it was not saved. Shared by the
 * judges' demo controls and the settings drawer.
 *
 * One change at a time (audit of 20 Oct, point 1): `busy` until the real call ends (the agent's own timeouts bound it),
 * and a second tap in the same instant, before React draws again, is dropped by a ref. A change that is refused or
 * throws ends as "not saved" (the day's quota used up says so, with when the demo comes back: closedNoticeOf), and the
 * choice goes back to what the demo plays.
 */
export function useSettingChange(onChange: (change: SetScenarioInput) => Promise<SettingChangeResult>, settings: DemoSettingsView | undefined) {
  const [pick, setPick] = useState<{ name: string; value: string } | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [applied, setApplied] = useState<'saved' | 'restarted' | 'failed' | undefined>(undefined);
  const [failure, setFailure] = useState<ErrorEnvelope | undefined>(undefined);
  const inFlight = useRef(false);
  const send = useCallback(
    (change: SetScenarioInput, picked?: { name: string; value: string }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPick(picked);
      setSending(true);
      setApplied(undefined);
      setFailure(undefined);
      void onChange(change)
        .catch((): SettingChangeResult => false)
        .then((result) => {
          inFlight.current = false;
          setSending(false);
          setPick(undefined);
          setFailure(typeof result === 'object' ? result : undefined);
          setApplied(result === true ? (change.restart === true ? 'restarted' : 'saved') : 'failed');
        });
    },
    [onChange],
  );
  const pendingOf = (name: string) => (pick?.name === name ? pick.value : undefined);
  const appliedText =
    sending ? t('settings.saving')
    : applied === 'failed' ? ((failure === undefined ? undefined : closedNoticeOf(failure)) ?? t('settings.failed'))
    : applied !== undefined && settings !== undefined
      ? t(applied === 'restarted' ? 'settings.restarted' : 'settings.applied', { place: t(`settings.place.${settings.locationId}`), scenario: t(`settings.scenario.${settings.scenarioId}`) })
      : '';
  const forget = useCallback(() => {
    setApplied(undefined);
    setFailure(undefined);
  }, []);
  return { send, pendingOf, appliedText, failed: applied === 'failed', busy: sending, forget };
}
