import type { InfraConfig } from '../src/index.js';

/** The values of cdk.json, as tests expect them. */
export const exampleConfig = (): InfraConfig => ({
  region: 'us-east-1',
  stages: ['dev', 'demo'],
  mcp: {
    clientsParameter: '/cold-reserve/{stage}/mcp-server/clients',
    memoryMb: 512,
    timeoutSeconds: 10,
    logRetentionDays: 14,
    p95AlarmMs: 500,
    ssmTimeoutMs: 2000,
    allowedOrigins: [],
    scenario: 'clear-day',
    scenarioAnchor: 'daily',
  },
  state: { connectTimeoutMs: 500, requestTimeoutMs: 1500, maxAttempts: 3 },
  agent: {
    modelId: 'us.amazon.nova-2-lite-v1:0',
    foundationModelId: 'amazon.nova-2-lite-v1:0',
    mcpTokenParameter: '/cold-reserve/{stage}/agent/mcp-token',
    idleRuntimeSessionTimeoutSeconds: 120,
  },
});
