import { PreferencesSchema, ReserveOutlookSchema, SafetyHardLimitsSchema, toPublicPreferences, type HomeStatus, type Household } from '@cold-reserve/contracts';
import { examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import { STORY_SAFE_ROOM_ID, playedHousehold } from '@cold-reserve/core';
import { homeInStorm, hotDayPlan, lastResortBatteryPlan, lastResortPlan, planThatHolds, safeRoomBatteryFirst, safeRoomCalm, safeRoomInStorm, stormPlan, surplusPlan } from '@cold-reserve/ui-cards';
import { demoRoomNames } from './demo-rooms.js';
import { ToolCardSchema, type ToolCard } from './wire.js';

// The tool results the script can show, by name: built from the contract fixtures, the same data the
// card tests use. The script file names them; it never embeds a plan by hand. Every fixture is parsed by
// the same schema as a remote result, so the script can never show what the contracts refuse.

/**
 * The demo home's display names (demoRoomNames: as the server's profile has them for who is at home), on every room a
 * scripted card shows, never a name made from the id, "Bedroom 1" (#422): the scripted home is the invented one.
 */
type RoomNames = Readonly<Record<string, string>>;
const namedBy = (names: RoomNames) => <T extends { readonly roomId: string; readonly name?: string | undefined }>(room: T): T => {
  const name = names[room.roomId];
  return name === undefined ? room : { ...room, name };
};
/**
 * The scripted home panel's status (calm, in the storm), from its fixture: on the safe room chosen in Settings and named
 * like the cards', for who is at home. Built from the fixture each time, never from a home already shown.
 */
export const withDemoHomeNames = (home: HomeStatus, household: Household = 'older-man', safeRoomId: string = STORY_SAFE_ROOM_ID): HomeStatus => {
  const placed = withSafeRoom(home, safeRoomId) as HomeStatus;
  return { ...placed, rooms: placed.rooms.map(namedBy(demoRoomNames(household))) };
};
const withDemoRoomNames = (parsed: ToolCard, DEMO_ROOM_NAMES: RoomNames): ToolCard => {
  const named = namedBy(DEMO_ROOM_NAMES);
  switch (parsed.tool) {
    case 'get_safe_room_status': {
      const name = DEMO_ROOM_NAMES[parsed.result.safeRoomId];
      return name === undefined ? parsed : { ...parsed, result: { ...parsed.result, safeRoomName: name } };
    }
    case 'get_home_status':
      return { ...parsed, result: { ...parsed.result, rooms: parsed.result.rooms.map(named) } };
    case 'get_preferences':
      // The settings name the safe room choices by these (#422), as the server's get_preferences does.
      return {
        ...parsed,
        result: {
          ...parsed.result,
          rooms: parsed.result.preferences.roomPriority.flatMap((id) => {
            const name = DEMO_ROOM_NAMES[id];
            return name === undefined ? [] : [{ id, name }];
          }),
        },
      };
    case 'plan_comfort':
      return 'surplus' in parsed.result && parsed.result.surplus !== undefined
        ? { ...parsed, result: { ...parsed.result, surplus: { ...parsed.result.surplus, rooms: parsed.result.surplus.rooms.map(named) } } }
        : parsed;
    default:
      return parsed;
  }
};

/** The keys that hold a room id in the scripted tool results. */
const ROOM_ID_KEYS = new Set(['roomId', 'roomIds', 'safeRoomId']);
/**
 * The fixtures protect bedroom-1; with another safe room chosen in Settings that room and bedroom-1 swap ids in every
 * card, so the card shows and plans the room the answer's words name (one source: the chosen safe room id).
 */
const withSafeRoom = (value: unknown, safeRoomId: string): unknown => {
  if (safeRoomId === STORY_SAFE_ROOM_ID) return value;
  const swap = (id: unknown) => (id === STORY_SAFE_ROOM_ID ? safeRoomId : id === safeRoomId ? STORY_SAFE_ROOM_ID : id);
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return key !== undefined && ROOM_ID_KEYS.has(key) ? swap(v) : v;
  };
  return walk(value);
};

// Each fixture builds its tool result; SCRIPT_FIXTURES parses it and names its rooms for who is at home.
const card = (value: unknown): unknown => value;

/**
 * The calm safe room of the demo home as its profile names it (#432 S6: the idle tile never says "Bedroom 1"): the room
 * chosen in Settings, named for who is at home; Leo is its person only while he is there (owner, 21 Oct).
 */
export const demoSafeRoom = (household: Household = 'older-man', safeRoomId = safeRoomCalm().safeRoomId) => {
  const room = { ...safeRoomCalm(), safeRoomId, safeRoomName: demoRoomNames(household)[safeRoomId] ?? safeRoomId };
  return playedHousehold(household) === 'older-man' ? { ...room, people: [{ role: 'grandpa', name: 'Leo' }] } : room;
};

/** The scripted home's last-resort confirmation (#160): a fixed, fake token, the shape the server returns. */
export const SCRIPTED_LAST_RESORT_TOKEN = `lr_${'scripted'.repeat(3)}`;

const FIXTURE_VALUES = {
  'hot-day-plan': () => card({ tool: 'plan_comfort', result: hotDayPlan() }),
  'hot-day-applied': () =>
    card({
      tool: 'apply_plan',
      result: { plan: { ...hotDayPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] },
    }),
  /** The model proposed too much (#186, scene 2b): the guard refused it, and the answer is the plan that holds (#202). */
  /** An ordinary sunny afternoon (#227, video scene 2a): where the solar surplus went instead of the grid. */
  // The demo home's own room names (#422): the scripted home is the invented one with the grandpa Leo, never the real home.
  'daily-routing': () => card({ tool: 'plan_comfort', result: surplusPlan() }),
  'plan-that-holds': () => card({ tool: 'plan_comfort', result: planThatHolds() }),
  /** A last resort (#160): the night limit cannot hold; the plan says until when, and how warm after. */
  'last-resort-plan': () => card({ tool: 'plan_comfort', result: lastResortPlan() }),
  /** The first yes: nothing is applied, the confirmation asks for a second yes. */
  'last-resort-pending': () =>
    card({
      tool: 'apply_plan',
      result: {
        plan: lastResortPlan(),
        alreadyApplied: false,
        advisoryOnly: false,
        manualInstructions: [],
        confirmation: { token: SCRIPTED_LAST_RESORT_TOKEN, expiresAt: '2026-07-15T21:20:00+02:00' },
      },
    }),
  /** The second yes: applied, and the registered family contact is told (#170). */
  'last-resort-applied': () =>
    card({
      tool: 'apply_plan',
      result: { plan: { ...lastResortPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [], familyAlert: { sent: 1, failed: 0 } },
    }),
  'reserve-outlook': () => card({ tool: 'get_reserve_outlook', result: ReserveOutlookSchema.parse(exampleReserveOutlook()) }),
  preferences: () =>
    card({
      tool: 'get_preferences',
      result: {
        preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())),
        isDefault: false,
        hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()),
      },
    }),
  'safe-room-storm': () => card({ tool: 'get_safe_room_status', result: safeRoomInStorm() }),
  'safe-room-calm': () => card({ tool: 'get_safe_room_status', result: { ...safeRoomCalm(), stormPhase: 'ended' } }),
  /** #364, #376: the battery runs out first (03:05), the room holds 24 °C until about 06:00; the plan from a Houston home. Not in the script: the e2e of the server's place. */
  'last-resort-battery-houston': () => card({ tool: 'plan_comfort', result: lastResortBatteryPlan('houston') }),
  'safe-room-battery-first': () => card({ tool: 'get_safe_room_status', result: safeRoomBatteryFirst() }),
  /** The night in the storm: the pacing line with the reserve as the budget (plan §11.3, Q4 of #24). */
  'storm-plan': () => card({ tool: 'plan_comfort', result: stormPlan() }),
  /** The thermal floor plan in the storm: the safe room served, the others waiting for the level (G8). */
  'home-storm': () => card({ tool: 'get_home_status', result: homeInStorm() }),
} as const satisfies Record<string, () => unknown>;

export type ScriptFixture = keyof typeof FIXTURE_VALUES;

/**
 * The script's tool results by name, parsed like a remote result: on the safe room chosen in Settings (bedroom-1 by
 * default), their rooms named for who is at home (Leo's by default). The preferences card is the settings themselves.
 */
export const SCRIPT_FIXTURES = Object.fromEntries(
  Object.entries(FIXTURE_VALUES).map(([name, value]) => [
    name,
    (household: Household = 'older-man', safeRoomId: string = STORY_SAFE_ROOM_ID) =>
      withDemoRoomNames(ToolCardSchema.parse(name === 'preferences' ? value() : withSafeRoom(value(), safeRoomId)), demoRoomNames(household)),
  ]),
) as Readonly<Record<ScriptFixture, (household?: Household, safeRoomId?: string) => ToolCard>>;

export const SCRIPT_FIXTURE_NAMES = Object.keys(SCRIPT_FIXTURES) as [ScriptFixture, ...ScriptFixture[]];
