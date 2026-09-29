/** Stateless MCP server: module registry, capability modules, Lambda and Node HTTP entry. */
export const packageName = '@cold-reserve/mcp-server';

export { createApp, type App, type AppOptions } from './app.js';
export { loadConfig, parseClients, type ClientGrant, type ServerConfig } from './config.js';
export { createMcpHandler, type LogEntry, type Logger, type McpHandler } from './handler.js';
export { createLambdaHandler, type FunctionUrlEvent, type FunctionUrlResult } from './lambda.js';
export { energyStatusModule, interimStatusDeriver, type HomeEntry, type StatusDeriver } from './modules/energy-status/index.js';
export { startNodeServer, type RunningServer } from './node-server.js';
export { preferencesModule, type PreferencesModuleDeps } from './modules/preferences.js';
export { createRegistry, type CapabilityModule, type ModuleRegistry } from './registry.js';
export { defineTool, listTool, type ToolAnnotations, type ToolContext, type ToolDefinition } from './tool.js';
