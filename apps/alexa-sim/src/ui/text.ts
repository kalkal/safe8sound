import { format, getLocale, type MessageKey } from '@cold-reserve/i18n';

/** Catalog text in the chosen language (#263; English by default). A missing placeholder is a bug: it throws to the error boundary. */
export function t(key: MessageKey, values: Readonly<Record<string, string>> = {}): string {
  const result = format(getLocale(), key, values);
  if (!result.ok) throw new Error(`Missing values for "${result.error.key}": ${result.error.missing.join(', ')}`);
  return result.value;
}

