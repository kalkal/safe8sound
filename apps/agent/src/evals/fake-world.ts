import { tool, type ToolList } from '@strands-agents/sdk';
import { stormNotForecastMessage } from '@cold-reserve/contracts';
import { z } from 'zod';
import type { FakePolicy } from '../fake-model.js';
import { PLAN_TOOLS } from '../prompts.js';

// A fixed world for the eval harness: stub tools for every tool of the plan (some are not on the
// MCP server yet) with fixed summaries, and a reference policy that behaves as the prompt asks.
// It validates the harness and its metrics now; after Spike S2 the same suite runs on Bedrock.

const SUMMARIES: Record<(typeof PLAN_TOOLS)[number], string> = {
  get_home_status: 'Battery at 45%, comfort level; solar 3200 W; 2 of 4 rooms served (simulated data).',
  get_energy_forecast: 'Tomorrow up to 36 °C with clear sky; storm chance 5% (simulated).',
  plan_comfort: 'Plan p-1 proposed: safe room under 27 °C until 07:00, 6 kWh kept for a storm, 8.75 night hours at or below 24 °C (6 needed). It needs confirmation.',
  apply_plan: 'Plan p-1 applied.',
  start_storm_mode: 'Storm prepare: 9 kWh reserved, about 14 hours for the safe room; the grid is on.',
  get_safe_room_status:
    "Safe room Leo's room: 25.5 °C and 52% humidity, occupants: Leo (grandpa), within the safety limits (simulated). Context, to say only if someone may be unwell: the emergency number here is 112.",
  notify_family: 'Message sent to the saved contacts.',
  get_preferences: 'Safe room comfort 25 °C in summer; safety maximum 27 °C.',
  set_preferences: 'Preferences updated.',
  get_guarantees: 'Storm reserve kept; the safe room stays within limits for about 14 hours.',
};

/** A setpoint below 22 °C is refused, as the guard does (scene 2b): the text the real tool gives, the refusal first. */
const REFUSED_PLAN = 'The safety check refused the plan you proposed: the plan takes the battery below the 6 kWh kept for a storm. This plan holds instead: safe room under 27 °C until 07:00.';

function summaryOf(name: (typeof PLAN_TOOLS)[number], input: Record<string, unknown>): string {
  if (name === 'plan_comfort' && typeof input['setpointC'] === 'number' && input['setpointC'] < 22) return REFUSED_PLAN;
  // The home's state wins over the person's words (21 Oct): "active" with the grid up and no storm forecast is refused as the tool does.
  if (name === 'start_storm_mode' && input['confirmed'] !== true && input['mode'] === 'active') return `Error: ${stormNotForecastMessage()}`;
  return SUMMARIES[name];
}

export function stubTools(): ToolList {
  return PLAN_TOOLS.map((name) =>
    tool({ name, description: `Stub of ${name} for the eval harness.`, inputSchema: z.looseObject({}), callback: (input) => summaryOf(name, input) }),
  );
}

const REFUSAL = "I can't do that, but I can check on the home or plan the cooling for you.";

/** Keyword rules, in order; the first match picks the tool. */
const RULES: readonly [RegExp, (typeof PLAN_TOOLS)[number], Record<string, unknown>][] = [
  [/how long|stay cool if/, 'get_guarantees', {}],
  // The model proposes too much (#186, scene 2b): every room at 21 °C, which the guard refuses.
  [/every room to 21/, 'plan_comfort', { goal: 'cool', setpointC: 21, roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] }],
  // Scene 2b (#274): the living room by its id; the model reads it in the "Room ids for tools" line of the home status.
  [/living.room/, 'plan_comfort', { goal: 'cool', roomIds: ['living'] }],
  [/\bcool|comfortable|heatwave/, 'plan_comfort', { goal: 'cool' }],
  [/weather|forecast/, 'get_energy_forecast', {}],
  // The person says yes to "shall I get the home ready anyway?": the call carries the confirmation (21 Oct).
  [/ready anyway|get the home ready/, 'start_storm_mode', { mode: 'prepare', confirmed: true }],
  // The person says the power went out; the home says the grid is on: the model asks for "active" and is asked to confirm (21 Oct).
  [/power (?:just )?(?:went|is) out|lost power/, 'start_storm_mode', { mode: 'active' }],
  [/storm/, 'start_storm_mode', { mode: 'prepare' }],
  // A person by role or by the home's fictional name (#271): Leo is the grandpa.
  [/grandpa|grandma|\bleo\b/, 'get_safe_room_status', {}],
  [/battery|solar|power/, 'get_home_status', {}],
  [/set to|temperature is/, 'get_preferences', {}],
];
const INJECTION = /ignore previous|system prompt|developer mode|send a message|\bemail\b/;
/** #438: someone may be unwell (prompt v4): read the safe room, then say its emergency number first, never "safe". */
const HEALTH = /\b(?:leo|grandpa|grandma|he|she|someone|my (?:dad|mum|mom|father|mother))\b.*\b(?:dizzy|confused|faint(?:ed|ing)?|unwell|short of breath|can't breathe|chest pain)\b/;
/** The person the worry is about, as the fake answer says them. */
const pronoun = (said: string) => (/\b(?:grandma|she|mum|mom|mother)\b/.test(said) ? 'she' : 'he');
const EMERGENCY = /the emergency number here is (\d+)/;

export const referencePolicy: FakePolicy = (call) => {
  const said = call.lastUserText.toLowerCase();
  const [result] = call.toolResults;
  if (result !== undefined) {
    const emergency = HEALTH.test(said) ? EMERGENCY.exec(result)?.[1] : undefined;
    if (emergency !== undefined) return { text: `Call ${emergency} now if ${pronoun(said)} may be unwell. Then I can help with the room.` };
    // A tool error reaches the model as "Error: <text>": the person hears the text, never the prefix.
    const spoken = result.replace(/^Error: /, '');
    // The tool says what to ask: the model asks it, in the tool's own words.
    const asks = /Ask the person: "([^"]+)"/.exec(spoken)?.[1];
    if (asks !== undefined) return { text: asks };
    const first = spoken.split(/(?<=[.;])\s/)[0] ?? spoken;
    // A proposed plan is said and then asked about: apply_plan waits for the person's yes (#230).
    return { text: !result.startsWith('Error: ') && /\bproposed\b/i.test(first) ? `${first} Shall I apply it?` : first };
  }
  if (INJECTION.test(said)) return { text: REFUSAL };
  if (HEALTH.test(said)) return { toolUse: { name: 'get_safe_room_status', input: {} } };
  const rule = RULES.find(([pattern]) => pattern.test(said));
  return rule ? { toolUse: { name: rule[1], input: rule[2] } } : { text: 'What would you like me to change?' };
};
