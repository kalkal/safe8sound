import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InfraConfig } from '../src/index.js';

/** A tiny built site (K1, #242): index.html, a hashed asset, a source map that must never ship, and its headers. */
export const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site');

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
    originSecretParameter: '/cold-reserve/{stage}/sim-api/origin-secret',
    originSecretPreviousParameter: '/cold-reserve/{stage}/sim-api/origin-secret-previous',
    phoneTokenParameter: '/cold-reserve/{stage}/sim-api/phone-token',
    memoryMb: 512,
    timeoutSeconds: 32,
    logRetentionDays: 14,
    p95AlarmMs: 9000,
    ssmTimeoutMs: 2000,
    agentTimeoutMs: 9000,
    mcpTimeoutMs: 3000,
    allowedOrigins: [],
    demoEnabled: { dev: true, demo: true },
    tokenTtlS: 3600,
    limits: { turnsPerCodePerDay: 20, turnsGlobalPerDay: 30, toolCallsPerCodePerDay: 20, codeAttemptsPerIpPerHour: 10, speechCharsPerCodePerDay: 6000, speechCharsGlobalPerDay: 30_000, phoneReadsPerSessionPerMinute: 20, phoneReadsPerCodePerMinute: 120 },
    speech: { enabled: { dev: false, demo: true }, engine: 'neural', voice: 'Joanna', pollyTimeoutMs: 2500, cacheTimeoutMs: 1000, cacheDays: 30 },
  },
});
