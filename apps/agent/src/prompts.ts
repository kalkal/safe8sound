import { readFileSync } from 'node:fs';
import { PRODUCT_NAME } from '@cold-reserve/i18n';
import { z } from 'zod';
import fewShotV1 from '../prompts/few-shot.v1.json' with { type: 'json' };

// The system prompt and few-shot dialogues are data, versioned in apps/agent/prompts/ (plan §4).
// A new version is a new file; the snapshot test shows every change in review.
export const PROMPT_VERSION = 'v1';

/** The MCP tools of the plan (§4). Few-shot dialogues may only use these. */
export const PLAN_TOOLS = [
  'get_home_status',
  'get_energy_forecast',
  'plan_comfort',
  'apply_plan',
  'start_storm_mode',
  'get_safe_room_status',
  'notify_family',
  'get_preferences',
  'set_preferences',
  'get_guarantees',
] as const;

const DialogueSchema = z.strictObject({
  id: z.string().regex(/^[a-z-]+$/),
  user: z.string().min(1).max(200),
  toolCalls: z.array(z.strictObject({ name: z.enum(PLAN_TOOLS), input: z.record(z.string(), z.unknown()), result: z.record(z.string(), z.unknown()) })),
  assistant: z.string().min(1).max(300),
});
export type Dialogue = z.infer<typeof DialogueSchema>;

/** Our own data: if it does not validate, that is a bug, so it throws at startup. */
export const FEW_SHOT: readonly Dialogue[] = z.array(DialogueSchema).parse(fewShotV1);

// TODO(S2, #6): readFileSync does not survive the esbuild bundle for AgentCore; import the prompt
// as text (loader) or generate a .ts module from it when the agent gets bundled.
export const SYSTEM_PROMPT_TEMPLATE = readFileSync(new URL(`../prompts/system.${PROMPT_VERSION}.md`, import.meta.url), 'utf8').trim();

function renderDialogue(d: Dialogue): string {
  const calls = d.toolCalls.map((c) => `Tool ${c.name} ${JSON.stringify(c.input)} -> ${JSON.stringify(c.result)}`);
  return [`User: ${d.user}`, ...calls, `Assistant: ${d.assistant}`].join('\n');
}

export function buildSystemPrompt(): string {
  const examples = FEW_SHOT.map(renderDialogue).join('\n\n');
  return `${SYSTEM_PROMPT_TEMPLATE.replaceAll('{product}', PRODUCT_NAME)}\n\nExamples:\n\n${examples}`;
}
