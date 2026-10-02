import { LogEntrySchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@cold-reserve/core';
import { createApp } from '../src/app.js';
import { toolCallMetric } from '../src/handler.js';
import { metricsTo } from '../src/lambda.js';
import { TOKEN, callTool, makeHandler, post, toolResult } from './helpers.js';

// G6 (#146): every tools/call leaves one info line in the shared log and one latency metric per tool, in
// CloudWatch Embedded Metric Format (a JSON line of its own, so the strict log line stays as it is).

const ID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';

/** A clock that moves 7 ms between two readings. */
const ticking = () => {
  let t = 1000;
  return () => (t += 7);
};

describe('one line and one metric per tools/call (#146)', () => {
  it('a call that succeeds: an info line with the tool, its duration and the outcome', async () => {
    const { handler, logs, metrics } = makeHandler({ now: ticking() });
    await toolResult(await post(handler, callTool('whoami', {}), { 'x-correlation-id': ID }));
    const line = logs.find((l) => l.level === 'info');
    expect(LogEntrySchema.parse(line)).toMatchObject({
      component: 'mcp-server',
      message: 'tools/call whoami',
      correlationId: ID,
      homeId: 'demo',
      details: { tool: 'whoami', durationMs: 7, outcome: 'ok' },
    });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ Tool: 'whoami', Outcome: 'ok', ToolLatency: 7 });
  });

  it('a tool error and a throwing handler are counted too, with their code', async () => {
    const { handler, logs, metrics } = makeHandler({ now: ticking() });
    await toolResult(await post(handler, callTool('explode', {})));
    const line = logs.find((l) => l.level === 'info');
    expect(line?.details).toMatchObject({ tool: 'explode', outcome: 'error', code: 'unexpected_error' });
    expect(metrics[0]).toMatchObject({ Tool: 'explode', Outcome: 'error' });
  });

  it('an unknown tool is not a tool call: no line, no metric', async () => {
    const { handler, logs, metrics } = makeHandler({ now: ticking() });
    await post(handler, callTool('nope', {}));
    expect(logs.filter((l) => l.level === 'info')).toHaveLength(0);
    expect(metrics).toHaveLength(0);
  });
});

describe('toolCallMetric (Embedded Metric Format)', () => {
  it('declares the latency in milliseconds, per tool, in the configured namespace', () => {
    expect(toolCallMetric({ namespace: 'ColdReserve/Test', tool: 'plan_comfort', outcome: 'ok', durationMs: 42, atMs: 1_700_000_000_000 })).toEqual({
      _aws: {
        Timestamp: 1_700_000_000_000,
        CloudWatchMetrics: [{ Namespace: 'ColdReserve/Test', Dimensions: [['Tool']], Metrics: [{ Name: 'ToolLatency', Unit: 'Milliseconds' }] }],
      },
      Tool: 'plan_comfort',
      Outcome: 'ok',
      ToolLatency: 42,
    });
  });
});

describe('wiring the metric (#146)', () => {
  it('createApp hands every tools/call metric to the sink it is given', async () => {
    const metrics: Record<string, unknown>[] = [];
    const app = createApp({ MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_METRICS_NAMESPACE: 'ColdReserve/Dev' }, { wallClock: fixedClock(Date.UTC(2026, 8, 29, 7)), logger: { log: () => undefined }, metrics: (m) => metrics.push(m) });
    if (!app.ok) throw new Error(app.error.message);
    await toolResult(await post(app.value.handler, callTool('get_home_status', {})));
    expect(metrics[0]).toMatchObject({ Tool: 'get_home_status', Outcome: 'ok', _aws: { CloudWatchMetrics: [{ Namespace: 'ColdReserve/Dev' }] } });
  });

  it('on Lambda each metric is one JSON line of its own', () => {
    const written: string[] = [];
    metricsTo((t) => written.push(t))({ Tool: 'x', ToolLatency: 1 });
    expect(written).toEqual(['{"Tool":"x","ToolLatency":1}\n']);
  });
});
