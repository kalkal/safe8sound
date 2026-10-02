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
  simApi: {
    demoCodesParameter: '/cold-reserve/{stage}/sim-api/demo-codes',
    tokenKeysParameter: '/cold-reserve/{stage}/sim-api/token-keys',
    mcpTokenParameter: '/cold-reserve/{stage}/sim-api/mcp-token',
    memoryMb: 512,
    timeoutSeconds: 15,
    logRetentionDays: 14,
    p95AlarmMs: 9000,
    ssmTimeoutMs: 2000,
    agentTimeoutMs: 9000,
    mcpTimeoutMs: 3000,
    allowedOrigins: [],
    demoEnabled: { dev: true, demo: true },
    tokenTtlS: 3600,
    limits: { turnsPerCodePerDay: 20, turnsGlobalPerDay: 30, toolCallsPerCodePerDay: 20, codeAttemptsPerIpPerHour: 10 },
  },
});
