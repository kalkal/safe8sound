import { format, type MessageKey } from '@cold-reserve/i18n';

/** Catalog text for the demo locale. A missing placeholder is a bug: it throws to the error boundary. */
export function t(key: MessageKey, values: Readonly<Record<string, string>> = {}): string {
  const result = format('en-US', key, values);
  if (!result.ok) throw new Error(`Missing values for "${result.error.key}": ${result.error.missing.join(', ')}`);
  return result.value;
}

/** Energy and power for people: kW/kWh with at most one decimal. */
export function formatMeasure(value: number, unit: string | undefined): string {
  const one = (n: number) => String(Math.round(n * 10) / 10);
  switch (unit) {
    case 'W':
      return `${one(value / 1000)} kW`;
    case 'Wh':
      return `${one(value / 1000)} kWh`;
    case 'C':
      return `${one(value)} °C`;
    case '%':
      return `${one(value)}%`;
    case 'min':
      return `${one(value)} min`;
    default:
      return one(value);
  }
}

/** Hours to the nearest half, as people say them: 9½, 18, ½. */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 2) / 2;
  const whole = Math.floor(rounded);
  const half = rounded > whole ? '½' : '';
  return whole === 0 && half !== '' ? half : `${String(whole)}${half}`;
}
