import { toolOutputJsonSchema, type ErrorEnvelope, type HomeId, type JsonObjectSchema, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

export interface ToolContext {
  readonly correlationId: string;
  readonly clientId: string;
  /** Derived from the bearer token, never from the arguments. */
  readonly homeId: HomeId;
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
  /** Short English text for `content`; defaults to the JSON of the output. */
  readonly summarize?: (output: z.output<O>) => string;
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
