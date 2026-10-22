import { PRODUCT_NAME } from '@cold-reserve/i18n';
import { z } from 'zod';
import fewShotV1 from '../prompts/few-shot.v1.json' with { type: 'json' };
import fewShotV5 from '../prompts/few-shot.v5.json' with { type: 'json' };
import fewShotV6 from '../prompts/few-shot.v6.json' with { type: 'json' };
import fewShotV7 from '../prompts/few-shot.v7.json' with { type: 'json' };
import fewShotV8 from '../prompts/few-shot.v8.json' with { type: 'json' };
import { SYSTEM_PROMPTS } from './prompts.generated.js';

// The system prompt and few-shot dialogues are data, versioned in apps/agent/prompts/ (plan §4).
// A new version is a new file, for the system prompt AND for its examples (a version never changes under an older one);
// the snapshot test shows every change in review, and a test freezes which examples file each version uses.
export const PROMPT_VERSION: keyof typeof SYSTEM_PROMPTS = 'v8';

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
const dialogues = (raw: unknown): readonly Dialogue[] => z.array(DialogueSchema).parse(raw);

/**
 * The examples file each prompt version uses: v1 to v4 the original one, v5 the one of 20 Oct (rooms and times as the tools
 * write them), v6 that plus the every-room example, v7 the same with the hot day asked as a forecast, v8 the same as v7 (only the rules change). A version's examples never change under it (a test freezes this map).
 */
export const FEW_SHOT_BY_VERSION: Readonly<Record<keyof typeof SYSTEM_PROMPTS, readonly Dialogue[]>> = {
  v1: dialogues(fewShotV1),
  v2: dialogues(fewShotV1),
  v3: dialogues(fewShotV1),
  v4: dialogues(fewShotV1),
  v5: dialogues(fewShotV5),
  v6: dialogues(fewShotV6),
  v7: dialogues(fewShotV7),
  v8: dialogues(fewShotV8),
};

/** The examples of the current version. */
export const FEW_SHOT: readonly Dialogue[] = FEW_SHOT_BY_VERSION[PROMPT_VERSION];

// The .md is the source people review; scripts/prompts.ts turns it into code, so the prompt survives the
// one-file CJS bundle for AgentCore (G1a). A test fails when the generated module is stale.
export const SYSTEM_PROMPT_TEMPLATE: string = SYSTEM_PROMPTS[PROMPT_VERSION];

function renderDialogue(d: Dialogue): string {
  const calls = d.toolCalls.map((c) => `Tool ${c.name} ${JSON.stringify(c.input)} -> ${JSON.stringify(c.result)}`);
  return [`User: ${d.user}`, ...calls, `Assistant: ${d.assistant}`].join('\n');
}

/** The prompt of a version: the current one by default; an older one only to compare them (the eval script). */
export function buildSystemPrompt(version: keyof typeof SYSTEM_PROMPTS = PROMPT_VERSION): string {
  const examples = FEW_SHOT_BY_VERSION[version].map(renderDialogue).join('\n\n');
  return `${SYSTEM_PROMPTS[version].replaceAll('{product}', PRODUCT_NAME)}\n\nExamples:\n\n${examples}`;
}

/** A prompt version by name, for the eval script (`EVAL_PROMPT_VERSION=v3`); undefined when there is none. */
export const promptVersionOf = (name: string | undefined): keyof typeof SYSTEM_PROMPTS | undefined =>
  name !== undefined && Object.hasOwn(SYSTEM_PROMPTS, name) ? (name as keyof typeof SYSTEM_PROMPTS) : undefined;
