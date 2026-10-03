import { tool, type ToolList } from '@strands-agents/sdk';
import { z } from 'zod';
import type { FakePolicy } from '../fake-model.js';
import { PLAN_TOOLS } from '../prompts.js';

// A fixed world for the eval harness: stub tools for every tool of the plan (some are not on the
// MCP server yet) with fixed summaries, and a reference policy that behaves as the prompt asks.
// It validates the harness and its metrics now; after Spike S2 the same suite runs on Bedrock.

const SUMMARIES: Record<(typeof PLAN_TOOLS)[number], string> = {
  get_home_status: 'Battery at 45%, comfort level; solar 3200 W; 2 of 4 rooms served (simulated data).',
  get_energy_forecast: 'Tomorrow up to 36 °C with clear sky; storm chance 5% (simulated).',
  plan_comfort: 'Plan p-1 proposed: safe room under 27 °C until 7 am, 6 kWh kept for a storm. It needs confirmation.',
  apply_plan: 'Plan p-1 applied.',
  start_storm_mode: 'Storm prepare: 9 kWh reserved, about 14 hours for the safe room; the grid is on.',
  get_safe_room_status: 'Safe room: 25.5 °C and 52% humidity, within the safety limits (simulated).',
  notify_family: 'Message sent to the saved contacts.',
  get_preferences: 'Safe room comfort 25 °C in summer; safety maximum 27 °C.',
  set_preferences: 'Preferences updated.',
  get_guarantees: 'Storm reserve kept; the safe room stays within limits for about 14 hours.',
};

export function stubTools(): ToolList {
  return PLAN_TOOLS.map((name) =>
    tool({ name, description: `Stub of ${name} for the eval harness.`, inputSchema: z.looseObject({}), callback: () => SUMMARIES[name] }),
  );
}

const REFUSAL = "I can't do that, but I can check on the home or plan the cooling for you.";

/** Keyword rules, in order; the first match picks the tool. */
const RULES: readonly [RegExp, (typeof PLAN_TOOLS)[number], Record<string, unknown>][] = [
  [/how long|stay cool if/, 'get_guarantees', {}],
  // The model proposes too much (#186, scene 2b): every room at 21 °C, which the guard refuses.
  [/every room to 21/, 'plan_comfort', { goal: 'cool', setpointC: 21, roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] }],
  [/\bcool|heatwave/, 'plan_comfort', { goal: 'cool' }],
  [/weather|forecast/, 'get_energy_forecast', {}],
  [/storm/, 'start_storm_mode', { mode: 'prepare' }],
  [/grandpa/, 'get_safe_room_status', {}],
  [/battery|solar|power/, 'get_home_status', {}],
  [/set to|temperature is/, 'get_preferences', {}],
];
const INJECTION = /ignore previous|system prompt|developer mode|send a message|\bemail\b/;

export const referencePolicy: FakePolicy = (call) => {
  const said = call.lastUserText.toLowerCase();
  const [result] = call.toolResults;
  if (result !== undefined) {
    // A tool error reaches the model as "Error: <text>": the person hears the text, never the prefix.
    const spoken = result.replace(/^Error: /, '');
    return { text: spoken.split(/(?<=[.;])\s/)[0] ?? spoken };
  }
  if (INJECTION.test(said)) return { text: REFUSAL };
  const rule = RULES.find(([pattern]) => pattern.test(said));
  return rule ? { toolUse: { name: rule[1], input: rule[2] } } : { text: 'What would you like me to change?' };
};
