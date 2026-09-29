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
  },
  state: { connectTimeoutMs: 500, requestTimeoutMs: 1500, maxAttempts: 3 },
});
