import type { ErrorEnvelope, ScenarioId, SetScenarioInput } from '@cold-reserve/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '../agent/agent.js';
import { applyChange, readDemoSettings, saveDemoSettings, scriptedDemoSettings, type DemoSettingsView } from '../ui/demo-settings.js';
import type { SettingChangeResult } from '../ui/use-setting-change.js';

export interface DemoSettingsState {
  /** The judge's demo settings; undefined for a home that is not a sandbox (or before the sandbox is read). */
  readonly settings: DemoSettingsView | undefined;
  /** Counts each new play of the day (Restart the day, a new scenario or place): the clock is read again on each. */
  readonly playthrough: number;
  /** Saves one change; resolves to true when it was stored, else its error (the day's quota is said as such). */
  readonly change: (change: SetScenarioInput) => Promise<SettingChangeResult>;
  /** Why the sandbox could not be read after Start, when it is the day's turns used up (closedNoticeOf), and when. */
  readonly unavailable: { readonly error: ErrorEnvelope; readonly at: number } | undefined;
}

/**
 * The judge's demo settings (B1, B2): kept in the page in scripted mode; in remote mode read from the visitor's
 * sandbox once the demo session starts, and saved there (what is shown is what is stored). A new scenario starts on
 * its own sky (`onScenario`); a new play of a sandbox reads the home and the phone again (`onNewPlay`).
 */
export function useDemoSettings(o: {
  agent: Agent;
  scripted: boolean;
  sessionToken: string | undefined;
  onScenario?: (scenarioId: ScenarioId) => void;
  onNewPlay?: () => void;
}): DemoSettingsState {
  const { agent, scripted, sessionToken, onScenario, onNewPlay } = o;
  const [settings, setSettings] = useState<DemoSettingsView | undefined>(() => (scripted ? scriptedDemoSettings() : undefined));
  const [playthrough, setPlaythrough] = useState(0);
  const [unavailable, setUnavailable] = useState<DemoSettingsState['unavailable']>(undefined);
  useEffect(() => {
    if (scripted || sessionToken === undefined) return undefined;
    // A failure that may pass is tried again (readDemoSettings); a new session or a closed page stops it.
    let wanted = true;
    void readDemoSettings(agent, { correlationId: crypto.randomUUID() }, { wanted: () => wanted }).then((read) => {
      if (!wanted) return;
      if (read.ok) setSettings(read.value);
      setUnavailable(!read.ok && read.error.code === 'demo_quota_exceeded' ? { error: read.error, at: Date.now() } : undefined);
    });
    return () => {
      wanted = false;
    };
  }, [agent, scripted, sessionToken]);
  const change = useCallback(
    async (c: SetScenarioInput): Promise<SettingChangeResult> => {
      const newPlay = c.restart === true || c.scenarioId !== undefined || c.locationId !== undefined;
      if (scripted) {
        setSettings((previous) => (previous === undefined ? previous : applyChange(previous, c)));
        // The scripted home plays the same change, so its simulated clock follows the scenario.
        await agent.callTool('set_scenario', { ...c }, { correlationId: crypto.randomUUID() });
        if (c.scenarioId !== undefined) onScenario?.(c.scenarioId);
        if (newPlay) setPlaythrough((n) => n + 1);
        return true;
      }
      const saved = await saveDemoSettings(agent, c, { correlationId: crypto.randomUUID() });
      if (!saved.ok) return saved.error;
      setSettings(saved.value);
      if (c.scenarioId !== undefined || c.restart === true) onScenario?.(saved.value.scenarioId);
      if (newPlay) {
        setPlaythrough((n) => n + 1);
        onNewPlay?.();
      }
      return true;
    },
    [agent, scripted, onScenario, onNewPlay],
  );
  return { settings, playthrough, change, unavailable };
}
