import { InboxMessageSchema, type Household, type InboxMessage, type SendableTransition } from '@cold-reserve/contracts';
import { stormMessage } from '@cold-reserve/i18n';
import { demoRoomNames } from '../agent/demo-rooms.js';

// The family messages of the storm scene (Saturday night, storm-blackout), rendered by the real
// i18n templates exactly as the server's notifier would, then parsed by the inbox contract.
// "Ana" is the scene's fictional daughter (the owner's names, 3 Oct: Leo the grandpa, Ana the daughter).

const ZONE = 'Europe/Rome';
const NAME = 'Ana';
const ms = (iso: string) => Date.parse(iso);

export const PHONE_FIXTURES = {
  'storm-started': { transition: 'storm_started', at: '2026-07-18T19:42:00+02:00', tempC: 26.8, safeUntil: '2026-07-19T06:40:00+02:00' },
  essential: { transition: 'essential_level', at: '2026-07-18T21:10:00+02:00', tempC: 26.8, safeUntil: '2026-07-19T06:40:00+02:00' },
  'power-back': { transition: 'power_back', at: '2026-07-19T05:52:00+02:00', tempC: 26.2, powerBackAt: '2026-07-19T05:48:00+02:00' },
  // The last resort of the hot-day scene (#160, #170): sent when the second yes applies it, before its 21:20 deadline.
  'last-resort': { transition: 'last_resort_applied', at: '2026-07-15T21:12:00+02:00', tempC: 23.6, safeUntil: '2026-07-15T22:00:00+02:00' },
} as const satisfies Record<string, { transition: SendableTransition; at: string; tempC: number; safeUntil?: string; powerBackAt?: string }>;

export type PhoneFixture = keyof typeof PHONE_FIXTURES;
export const PHONE_FIXTURE_NAMES = Object.keys(PHONE_FIXTURES) as [PhoneFixture, ...PhoneFixture[]];

/** Which room the message is about: the safe room chosen in Settings, named for who is at home (owner, 21 Oct). */
export interface PhoneRoom {
  readonly household?: Household;
  readonly safeRoomId?: string;
}

export function phoneMessage(name: PhoneFixture, room: PhoneRoom = {}): InboxMessage {
  const safeRoomId = room.safeRoomId ?? 'bedroom-1';
  const f: { transition: SendableTransition; at: string; tempC: number; safeUntil?: string; powerBackAt?: string } = PHONE_FIXTURES[name];
  const text = stormMessage('en-US', f.transition, NAME, {
    roomName: demoRoomNames(room.household ?? 'older-man')[safeRoomId] ?? safeRoomId,
    tempC: f.tempC,
    atMs: ms(f.at),
    timeZone: ZONE,
    ...(f.safeUntil === undefined ? {} : { safeUntilMs: ms(f.safeUntil) }),
    ...(f.powerBackAt === undefined ? {} : { powerBackAtMs: ms(f.powerBackAt) }),
  });
  if (!text.ok) throw new Error(`Phone fixture "${name}" misses ${text.error.missing.join(', ')}`);
  return InboxMessageSchema.parse({ at: f.at, role: 'daughter', channel: 'in_app', transition: f.transition, text: text.value });
}
