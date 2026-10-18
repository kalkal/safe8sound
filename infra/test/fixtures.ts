import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InfraConfig } from '../src/index.js';

/** A tiny built site (K1, #242): index.html, a hashed asset, a source map that must never ship, and its headers. */
export const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site');

/** The values of cdk.json, as tests expect them. */
export const exampleConfig = (): InfraConfig => ({
  region: 'us-east-1',
  stages: ['dev', 'demo'],
  turnTiming: { agentDeadlineMs: 12_000, agentMarginMs: 2000, browserTimeoutMs: 16_000, turnBudgetMs: 18_000 },
  alexa: { stages: ['dev'], tokenParameter: '/cold-reserve/{stage}/alexa-skill/mcp-token', memoryMb: 256, timeoutSeconds: 7, logRetentionDays: 14, deadlineMs: 6000, ssmTimeoutMs: 1500, mcpTimeoutMs: 4000, tempUnit: 'C' },
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
  warmup: { enabled: { dev: false, demo: false }, rateMinutes: 5 },
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
    mcpTimeoutMs: 10_000,
    allowedOrigins: [],
    demoEnabled: { dev: true, demo: true },
    tokenTtlS: 3600,
    // Caps per stage: dev keeps the values it was built with; demo gives the judges' one shared code the whole day
    // (300 turns, #445), and the owner's own code small caps outside it, so the global caps are the two added up.
    limits: {
      dev: { turnsPerCodePerDay: 20, turnsGlobalPerDay: 30, toolCallsPerCodePerDay: 20, readCallsPerCodePerDay: 200, readCallsGlobalPerDay: 2000, demoCallsPerCodePerDay: 150, codeAttemptsPerIpPerHour: 10, speechCharsPerCodePerDay: 6000, speechCharsGlobalPerDay: 30_000, phoneReadsPerSessionPerMinute: 20, phoneReadsPerCodePerMinute: 120, logLinesPerSessionPerMinute: 30, logLinesGlobalPerMinute: 600 },
      demo: { turnsPerCodePerDay: 300, turnsGlobalPerDay: 320, toolCallsPerCodePerDay: 300, readCallsPerCodePerDay: 2000, readCallsGlobalPerDay: 2200, demoCallsPerCodePerDay: 500, codeAttemptsPerIpPerHour: 10, speechCharsPerCodePerDay: 30_000, speechCharsGlobalPerDay: 36_000, phoneReadsPerSessionPerMinute: 20, phoneReadsPerCodePerMinute: 120, logLinesPerSessionPerMinute: 30, logLinesGlobalPerMinute: 600 },
    },
    codeLimits: {
      dev: {},
      demo: { owner: { turnsPerCodePerDay: 20, toolCallsPerCodePerDay: 20, readCallsPerCodePerDay: 200, demoCallsPerCodePerDay: 150, speechCharsPerCodePerDay: 6000 } },
    },
    speech: { enabled: { dev: false, demo: true }, engine: 'neural', voice: 'Joanna', pollyTimeoutMs: 2500, cacheTimeoutMs: 1000, cacheDays: 30 },
  },
});
