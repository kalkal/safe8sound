import { formatTemp } from '@cold-reserve/contracts';
import { format, getLocale, type MessageKey } from '@cold-reserve/i18n';
import { getTempUnit } from './temp-unit.js';

/** Catalog text in the chosen language (#263; English by default). A missing placeholder is a bug: it throws to the error boundary. */
export function t(key: MessageKey, values: Readonly<Record<string, string>> = {}): string {
  const result = format(getLocale(), key, values);
  if (!result.ok) throw new Error(`Missing values for "${result.error.key}": ${result.error.missing.join(', ')}`);
  return result.value;
}

/** Energy, power and temperatures for people: kW/kWh with at most one decimal, °C or °F as chosen. */
export function formatMeasure(value: number, unit: string | undefined): string {
  const one = (n: number) => String(Math.round(n * 10) / 10);
  switch (unit) {
    case 'W':
      return `${one(value / 1000)} kW`;
    case 'Wh':
      return `${one(value / 1000)} kWh`;
    // A temperature in the unit the person chose (°C in the data).
    case 'C':
      return formatTemp(value, getTempUnit());
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
