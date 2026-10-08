import { toolOutputJsonSchema, type ErrorEnvelope, type HomeId, type JsonObjectSchema, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

export interface ToolContext {
  readonly correlationId: string;
  readonly clientId: string;
  /** Derived from the bearer token, never from the arguments. */
  readonly homeId: HomeId;
  /** The conversation turn (TURN_HEADER, #230): set by the agent on its calls, never by a card tap. */
  readonly turnId?: string;
}

/** MCP tool annotations: every tool states them explicitly (plan §4). */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly input: I;
  readonly output: O;
  readonly handler: (args: z.output<I>, ctx: ToolContext) => Promise<Result<z.input<O>, ErrorEnvelope>>;
  /** Short English text for `content`; defaults to the JSON of the output. The context names the home (#274). */
  readonly summarize?: (output: z.output<O>, ctx: ToolContext) => string;
  /** The MCP Apps card that shows the result (#92): a `ui://` resource of the same module. */
  readonly ui?: { readonly resourceUri: string };
}

/** Keeps the handler typed against its own schemas. */
export function defineTool<I extends z.ZodObject, O extends z.ZodType>(def: ToolDefinition<I, O>): ToolDefinition {
  return def;
}

export interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObjectSchema;
  outputSchema: JsonObjectSchema;
  annotations: ToolAnnotations;
  _meta?: { ui: { resourceUri: string }; 'ui/resourceUri': string };
}

export function listTool(tool: ToolDefinition): ListedTool {
  const input: Record<string, unknown> = { ...z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'throw' }) };
  delete input['$schema'];
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { ...input, type: 'object' },
    outputSchema: toolOutputJsonSchema(tool.output),
    annotations: { ...tool.annotations },
    // The flat `ui/resourceUri` key is the older MCP Apps form, still read by some hosts (spike S3).
    ...(tool.ui === undefined ? {} : { _meta: { ui: { resourceUri: tool.ui.resourceUri }, 'ui/resourceUri': tool.ui.resourceUri } }),
  };
}

/**
 * A tool error with a sentence meant for the model only (#272): the server appends it to the text the model reads
 * and drops it from `structuredContent`, so a card never shows an instruction to the model.
 */
export type HintedError = ErrorEnvelope & { readonly modelHint?: string };

export const withModelHint = (error: ErrorEnvelope, modelHint: string): HintedError => ({ ...error, modelHint });
