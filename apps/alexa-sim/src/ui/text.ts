import { format, type MessageKey } from '@cold-reserve/i18n';

/** Catalog text for the demo locale. A missing placeholder is a bug: it throws to the error boundary. */
export function t(key: MessageKey, values: Readonly<Record<string, string>> = {}): string {
  const result = format('en-US', key, values);
  if (!result.ok) throw new Error(`Missing values for "${result.error.key}": ${result.error.missing.join(', ')}`);
  return result.value;
}

/** "hh:mm" in the home's own offset, as the measurement reported it (no browser time zone involved). */
export const homeClock = (isoTs: string): string => isoTs.slice(11, 16);
