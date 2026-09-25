import { z } from 'zod';
import type { Result } from './result.js';
import { ToolErrorSchema, type ToolError } from './tool-error.js';

export interface ToolContext {
  correlationId: string;
  clientId: string;
}

export interface ToolDefinition<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: I;
  output: O;
  handler: (args: z.infer<I>, ctx: ToolContext) => Promise<Result<z.infer<O>, ToolError>>;
  /** Short English text for `content`; defaults to the JSON of the output. */
  summarize?: (output: z.infer<O>) => string;
}

export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return def;
}

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  // Zod v4 native conversion (no zod-to-json-schema). `$schema` is dropped: MCP
  // 2025-11-25 already defaults to 2020-12 and some validators choke on the URI.
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'throw' }) as JsonSchema;
  return rest;
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: 'object' };
  outputSchema: JsonSchema & { type: 'object' };
}

export function listTool(tool: ToolDefinition): ListedTool {
  const input = toJsonSchema(tool.input, 'input');
  // The TypeScript SDK client validates structuredContent against outputSchema even
  // when isError is true, so the advertised schema admits the error envelope too.
  const output = toJsonSchema(z.union([tool.output, ToolErrorSchema]), 'output');
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { ...input, type: 'object' },
    outputSchema: { type: 'object', ...output },
  };
}
