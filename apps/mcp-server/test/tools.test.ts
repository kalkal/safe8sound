import { ErrorEnvelopeSchema, err, toolError } from '@cold-reserve/contracts';
import { z } from 'zod';
import { defineTool, withModelHint } from '../src/tool.js';
import { describe, expect, it } from 'vitest';
import { callTool, makeHandler, post, toolResult, toolsList } from './helpers.js';

interface ListedTool {
  name: string;
  title: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

describe('tools/list', () => {
  it('advertises object input schemas, anyOf [success, error envelope] outputs and the annotations', async () => {
    const { handler } = makeHandler();
    const body = (await (await post(handler, toolsList)).json()) as { result: { tools: ListedTool[] } };
    const whoami = body.result.tools.find((t) => t.name === 'whoami');
    expect(whoami?.title).toBe('Who am I');
    expect(whoami?.inputSchema.type).toBe('object');
    expect(whoami?.inputSchema).not.toHaveProperty('$schema');
    expect(whoami?.outputSchema.type).toBe('object');
    expect(whoami?.outputSchema['anyOf']).toHaveLength(2);
    expect(whoami?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });
});

describe('tools/call failure paths', () => {
  it('returns isError + invalid_input with the issues when the input breaks the schema', async () => {
    const { handler, logs } = makeHandler();
    const result = await toolResult(await post(handler, callTool('whoami', { note: 'far too long for ten' })));
    expect(result.isError).toBe(true);
    const error = ErrorEnvelopeSchema.parse(result.structuredContent);
    expect(error).toMatchObject({ code: 'invalid_input', category: 'validation', retryable: false });
    expect(error.details?.issues?.[0]?.path).toBe('note');
    expect(result.content[0]?.text).toBe(error.message);
    expect(logs.filter((l) => l.level !== 'info')).toHaveLength(0); // validation is not kept in the error log
  });

  it('treats missing arguments as an empty object', async () => {
    const { handler } = makeHandler();
    const result = await toolResult(await post(handler, callTool('whoami')));
    expect(result.isError).toBeFalsy();
  });

  it('answers an unknown tool with a JSON-RPC protocol error (-32602)', async () => {
    const { handler } = makeHandler();
    const body = (await (await post(handler, callTool('no_such_tool', {}))).json()) as { error?: { code: number }; result?: unknown };
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32602);
  });

  it('turns a thrown exception into isError + unexpected_error without leaking internals, logged once', async () => {
    const { handler, logs } = makeHandler();
    const id = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
    const result = await toolResult(await post(handler, callTool('explode', {}), { 'x-correlation-id': id }));
    expect(ErrorEnvelopeSchema.parse(result.structuredContent)).toMatchObject({ code: 'unexpected_error', category: 'internal' });
    expect(JSON.stringify(result)).not.toContain('/secret/path');
    const errors = logs.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ level: 'error', code: 'unexpected_error', correlationId: id, homeId: 'demo' });
  });

  it('turns an output that breaks its own schema into isError + output_schema_violation, logged', async () => {
    const { handler, logs } = makeHandler();
    const result = await toolResult(await post(handler, callTool('bad_output', {})));
    expect(ErrorEnvelopeSchema.parse(result.structuredContent)).toMatchObject({ code: 'output_schema_violation' });
    expect(logs.filter((l) => l.level !== 'info').map((l) => l.code)).toEqual(['output_schema_violation']);
  });
});

describe('a hint meant for the model (#272)', () => {
  it('reaches the text the model reads, never the structured error a card shows', async () => {
    const hinted = defineTool({
      name: 'hinted_refusal',
      title: 'Hinted refusal',
      description: 'Test tool.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      input: z.strictObject({}),
      output: z.strictObject({}),
      handler: () => Promise.resolve(err(withModelHint(toolError('safe_room_comfort_violated', 'Humidity in the safe room would reach 94 %.'), 'Call plan_comfort again with only the goal.'))),
    });
    const { handler } = makeHandler({ modules: [{ id: 'hinted', tools: [hinted] }] });
    const result = await toolResult(await post(handler, callTool('hinted_refusal', {})));
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toBe('Humidity in the safe room would reach 94 %. Call plan_comfort again with only the goal.');
    const envelope = ErrorEnvelopeSchema.parse(result.structuredContent);
    expect(envelope.message).toBe('Humidity in the safe room would reach 94 %.');
    expect(JSON.stringify(result.structuredContent)).not.toContain('plan_comfort again');
  });
});
