import { err, ok, type Result } from '@cold-reserve/contracts';

// Every user-facing string lives in a catalog (plan §14.1). en-US for the hackathon; it-IT later.

/** The one place the product name lives: it is still a working name. Catalogs use {product}. */
export const PRODUCT_NAME = 'Cold Reserve';

const enUS = {
  'app.welcome': 'Welcome to {product}.',
  'level.changed': "I'm switching to {level} mode so the safe room stays comfortable until {until}.",
  'data.simulated': 'Simulated data',
  'data.asOf': 'As of {time}',
  'data.live': 'LIVE',
  'data.simulatedBadge': 'SIMULATED',
  'sim.title': '{product} · Alexa+ simulator',
  'chat.label': 'Ask a question',
  'chat.placeholder': "What's my battery level?",
  'chat.send': 'Ask',
  'chat.thinking': 'Thinking…',
  'chat.cancel': 'Cancel',
  'chat.degraded': "I can't reach the assistant right now, so this is a scripted answer.",
  'chat.errorTransient': "I can't answer right now. Try again in a moment.",
  'chat.errorOther': 'Something went wrong with this answer. Try asking in a different way.',
  'chat.retry': 'Try again',
  'status.battery': 'Battery',
  'surface.failed': 'This part of the screen stopped working. Reload the page to try again.',
  'config.invalid': 'The simulator is not configured correctly. Check its settings and reload the page.',
} as const;

export type MessageKey = keyof typeof enUS;
export const CATALOGS = { 'en-US': enUS } satisfies Record<string, Record<MessageKey, string>>;
export type Locale = keyof typeof CATALOGS;
export const LOCALES = Object.keys(CATALOGS) as Locale[];

export interface FormatError {
  key: MessageKey;
  missing: string[];
}

export function format(locale: Locale, key: MessageKey, values: Readonly<Record<string, string>> = {}): Result<string, FormatError> {
  const template: string = CATALOGS[locale][key];
  const filled: Readonly<Record<string, string>> = { product: PRODUCT_NAME, ...values };
  const missing = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').filter((name) => !(name in filled));
  if (missing.length > 0) return err({ key, missing });
  return ok(template.replace(/\{(\w+)\}/g, (_, name: string) => filled[name] ?? ''));
}
