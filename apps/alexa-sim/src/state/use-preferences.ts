import { categoryOf, type GetPreferencesOutput } from '@cold-reserve/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '../agent/agent.js';
import { withSaved, type LimitChange, type LimitSave } from '../ui/limits.js';
import { fetchPreferences, savePreferences } from '../ui/preferences-settings.js';

/**
 * #402: the preferences and the limits they move inside. Read when `enabled` (the sandbox or the scripted home) and
 * again when `key` changes (its day or place); a failed read leaves them unknown. One instance is meant to serve every
 * view of the settings (the Echo now, Ana's phone from step S5), so a change made in one shows in the other with no second read.
 */
export function usePreferences(o: { agent: Agent; enabled: boolean; key: string }): {
  limits: GetPreferencesOutput | undefined;
  saveLimit: (change: LimitChange) => Promise<LimitSave>;
} {
  const { agent, enabled, key } = o;
  const [limits, setLimits] = useState<GetPreferencesOutput | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    void fetchPreferences(agent, { correlationId: crypto.randomUUID() }).then((read) => {
      if (current && read.ok) setLimits(read.value);
    });
    return () => {
      current = false;
    };
  }, [agent, enabled, key]);
  const saveLimit = useCallback(
    async (change: LimitChange): Promise<LimitSave> => {
      const saved = await savePreferences(agent, change, { correlationId: crypto.randomUUID() });
      // What the tool stored is what is shown: the view comes from its output, with no second read.
      if (saved.ok) {
        setLimits((previous) => (previous === undefined ? previous : withSaved(previous, saved.value.preferences)));
        return 'saved';
      }
      return categoryOf(saved.error.code) === 'rate_limited' ? 'rate_limited' : 'failed';
    },
    [agent],
  );
  return { limits, saveLimit };
}
