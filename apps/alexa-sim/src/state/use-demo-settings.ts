import type { ScenarioId, SetScenarioInput } from '@cold-reserve/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '../agent/agent.js';
import { applyChange, fetchDemoSettings, saveDemoSettings, scriptedDemoSettings, type DemoSettingsView } from '../ui/demo-settings.js';

export interface DemoSettingsState {
  /** The judge's demo settings; undefined for a home that is not a sandbox (or before the sandbox is read). */
  readonly settings: DemoSettingsView | undefined;
  /** Counts each new play of the day (Restart the day, a new scenario or place): the clock is read again on each. */
  readonly playthrough: number;
  /** Saves one change; resolves to whether it was stored. */
  readonly change: (change: SetScenarioInput) => Promise<boolean>;
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
  useEffect(() => {
    if (scripted || sessionToken === undefined) return;
    void fetchDemoSettings(agent, { correlationId: crypto.randomUUID() }).then((read) => {
      if (read.ok) setSettings(read.value);
    });
  }, [agent, scripted, sessionToken]);
  const change = useCallback(
    async (c: SetScenarioInput) => {
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
      if (!saved.ok) return false;
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
  return { settings, playthrough, change };
}
