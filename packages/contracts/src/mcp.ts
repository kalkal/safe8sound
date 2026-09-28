import { z } from 'zod';
import { ErrorEnvelopeSchema } from './errors.js';

/**
 * The advertised `outputSchema` of every MCP tool: anyOf [success, error envelope].
 * The TypeScript SDK client validates `structuredContent` even when `isError` is true
 * (spike S1, issue #5), so the error envelope must be part of the schema.
 */
export const toolOutputSchema = <T extends z.ZodType>(success: T) => z.union([success, ErrorEnvelopeSchema]);

export type JsonObjectSchema = Record<string, unknown> & { type: 'object' };

/**
 * JSON Schema for `tools/list`: MCP requires an object root, so `type: "object"` sits next to
 * the anyOf (the shape spike S1 checked with the SDK client). `$schema` is dropped: MCP
 * 2025-11-25 defaults to JSON Schema 2020-12.
 */
export function toolOutputJsonSchema(success: z.ZodType): JsonObjectSchema {
  const json: Record<string, unknown> = { ...z.toJSONSchema(toolOutputSchema(success), { io: 'output', unrepresentable: 'throw' }) };
  delete json['$schema'];
  return { ...json, type: 'object' };
}
