import { PreferencesSchema, ReserveOutlookSchema, SafetyHardLimitsSchema, toPublicPreferences, type Plan } from '@cold-reserve/contracts';
import { examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import { homeInStorm, hotDayPlan, lastResortBatteryPlan, lastResortPlan, planThatHolds, safeRoomBatteryFirst, safeRoomCalm, safeRoomInStorm, stormPlan, surplusPlan } from '@cold-reserve/ui-cards';
import { ToolCardSchema, type ToolCard } from './wire.js';

// The tool results the script can show, by name: built from the contract fixtures, the same data the
// card tests use. The script file names them; it never embeds a plan by hand. Every fixture is parsed by
// the same schema as a remote result, so the script can never show what the contracts refuse.

const card = (value: unknown): ToolCard => ToolCardSchema.parse(value);

/** The demo home's display names (as its profile has them) on the surplus rooms, so the card says "Leo's room" (#422). */
const DEMO_ROOM_NAMES: Readonly<Record<string, string>> = { 'bedroom-1': "Leo's room", living: 'Living room' };
const withDemoRoomNames = (plan: Plan): Plan =>
  plan.surplus === undefined
    ? plan
    : { ...plan, surplus: { ...plan.surplus, rooms: plan.surplus.rooms.map((r) => {
          const name = DEMO_ROOM_NAMES[r.roomId];
          return name === undefined ? r : { ...r, name };
        }) } };

/** The calm safe room of the demo home as its profile names it (#432 S6: the idle tile says "Leo's room", never "Bedroom 1"). */
export const demoSafeRoom = () => ({ ...safeRoomCalm(), safeRoomName: DEMO_ROOM_NAMES['bedroom-1'] ?? 'bedroom-1', people: [{ role: 'grandpa', name: 'Leo' }] });

/** The scripted home's last-resort confirmation (#160): a fixed, fake token, the shape the server returns. */
export const SCRIPTED_LAST_RESORT_TOKEN = `lr_${'scripted'.repeat(3)}`;

export const SCRIPT_FIXTURES = {
  'hot-day-plan': () => card({ tool: 'plan_comfort', result: hotDayPlan() }),
  'hot-day-applied': () =>
    card({
      tool: 'apply_plan',
      result: { plan: { ...hotDayPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] },
    }),
  /** The model proposed too much (#186, scene 2b): the guard refused it, and the answer is the plan that holds (#202). */
  /** An ordinary sunny afternoon (#227, video scene 2a): where the solar surplus went instead of the grid. */
  // The demo home's own room names (#422): the scripted home is the invented one with the grandpa Leo, never the real home.
  'daily-routing': () => card({ tool: 'plan_comfort', result: withDemoRoomNames(surplusPlan()) }),
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
} as const satisfies Record<string, () => ToolCard>;

export type ScriptFixture = keyof typeof SCRIPT_FIXTURES;
export const SCRIPT_FIXTURE_NAMES = Object.keys(SCRIPT_FIXTURES) as [ScriptFixture, ...ScriptFixture[]];
