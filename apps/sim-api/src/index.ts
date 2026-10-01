/** sim-api (#101): demo-code auth, daily caps, kill switch, agent proxy and card actions. */
export const packageName = '@cold-reserve/sim-api';

export { loadSimApiConfig, type SimApiConfig } from './config.js';
export { createSimApiHandler, type CardToolPort, type LogLine, type SimApiDeps, type SimApiHandler, type TurnAgentPort } from './handler.js';
export { createQuota, memoryQuotaStore, type Quota, type QuotaLimits, type QuotaStore } from './quota.js';
export { signToken, verifyToken, type DemoClaims, type TokenKey } from './token.js';
export { httpTurnAgent } from './adapters/agent-http.js';
export { mcpCardTools, streamableMcpCaller, type McpCaller } from './adapters/mcp-cards.js';
