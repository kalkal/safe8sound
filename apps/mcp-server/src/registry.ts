import { err, ok, toolError, type ErrorEnvelope, type HomeId, type Result } from '@cold-reserve/contracts';
import type { ToolDefinition } from './tool.js';

/**
 * A capability module (plan §14.1): a feature with its tools, switched on per home.
 * `energy-status` is the first; comfort-plan, storm-mode, family-notify and preferences plug in
 * here without touching the others.
 */
export interface CapabilityModule {
  readonly id: string;
  readonly tools: readonly ToolDefinition[];
  /** The MCP Apps cards of the module's tools (#92). */
  readonly resources?: readonly UiResource[];
  /** Per-home flag; a module without it is on for every home. */
  readonly enabledFor?: (homeId: HomeId) => boolean;
}

/** A `ui://` resource: one HTML document, built when a host reads it. */
export interface UiResource {
  readonly uri: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  read(): Result<string, ErrorEnvelope>;
}

export interface ModuleRegistry {
  readonly moduleIds: readonly string[];
  toolsFor(homeId: HomeId): readonly ToolDefinition[];
  findTool(name: string, homeId: HomeId): ToolDefinition | undefined;
  resourcesFor(homeId: HomeId): readonly UiResource[];
  findResource(uri: string, homeId: HomeId): UiResource | undefined;
}

const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const RESOURCE_URI = /^ui:\/\/cold-reserve\/[a-z0-9]+(-[a-z0-9]+)*$/;

/** Wiring mistakes are configuration errors found at startup, not at the first call. */
export function createRegistry(modules: readonly CapabilityModule[]): Result<ModuleRegistry, ErrorEnvelope> {
  const owner = new Map<string, CapabilityModule>();
  const byName = new Map<string, ToolDefinition>();
  const resourceOwner = new Map<string, CapabilityModule>();
  const byUri = new Map<string, UiResource>();
  const ids = new Set<string>();
  for (const module of modules) {
    if (!MODULE_ID.test(module.id)) return err(toolError('invalid_config', `Module id "${module.id}" is not kebab-case.`));
    if (ids.has(module.id)) return err(toolError('invalid_config', `Module "${module.id}" is registered twice.`));
    if (module.tools.length === 0) return err(toolError('invalid_config', `Module "${module.id}" has no tools.`));
    ids.add(module.id);
    for (const tool of module.tools) {
      if (!TOOL_NAME.test(tool.name)) return err(toolError('invalid_config', `Tool name "${tool.name}" is not snake_case.`));
      const other = owner.get(tool.name);
      if (other) return err(toolError('invalid_config', `Tool "${tool.name}" is registered by "${other.id}" and "${module.id}".`));
      owner.set(tool.name, module);
      byName.set(tool.name, tool);
    }
    for (const resource of module.resources ?? []) {
      if (!RESOURCE_URI.test(resource.uri)) return err(toolError('invalid_config', `Resource "${resource.uri}" is not a ui://cold-reserve/ uri.`));
      const other = resourceOwner.get(resource.uri);
      if (other) return err(toolError('invalid_config', `Resource "${resource.uri}" is registered by "${other.id}" and "${module.id}".`));
      resourceOwner.set(resource.uri, module);
      byUri.set(resource.uri, resource);
    }
  }
  // A card lives in its tool's module, so no home ever sees a tool whose card is switched off.
  for (const [name, tool] of byName) {
    const uri = tool.ui?.resourceUri;
    if (uri !== undefined && resourceOwner.get(uri) !== owner.get(name)) {
      return err(toolError('invalid_config', `Tool "${name}" links "${uri}", which its module does not register.`));
    }
  }

  const enabled = (module: CapabilityModule, homeId: HomeId) => module.enabledFor?.(homeId) ?? true;
  return ok({
    moduleIds: [...ids],
    toolsFor: (homeId) => modules.filter((m) => enabled(m, homeId)).flatMap((m) => m.tools),
    findTool: (name, homeId) => {
      const module = owner.get(name);
      return module && enabled(module, homeId) ? byName.get(name) : undefined;
    },
    resourcesFor: (homeId) => modules.filter((m) => enabled(m, homeId)).flatMap((m) => m.resources ?? []),
    findResource: (uri, homeId) => {
      const module = resourceOwner.get(uri);
      return module && enabled(module, homeId) ? byUri.get(uri) : undefined;
    },
  });
}
