import { err, ok, toolError, type ErrorEnvelope, type HomeId, type Result } from '@cold-reserve/contracts';
import type { ToolDefinition } from './tool.js';

/**
 * A capability module (plan §14.1): a feature with its tools, switched on per home.
 * `energy-status` is the first; comfort-plan, storm-mode, family-notify and preferences plug in
 * here without touching the others. `ui://` resources join this interface with the first card.
 */
export interface CapabilityModule {
  readonly id: string;
  readonly tools: readonly ToolDefinition[];
  /** Per-home flag; a module without it is on for every home. */
  readonly enabledFor?: (homeId: HomeId) => boolean;
}

export interface ModuleRegistry {
  readonly moduleIds: readonly string[];
  toolsFor(homeId: HomeId): readonly ToolDefinition[];
  findTool(name: string, homeId: HomeId): ToolDefinition | undefined;
}

const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Wiring mistakes are configuration errors found at startup, not at the first call. */
export function createRegistry(modules: readonly CapabilityModule[]): Result<ModuleRegistry, ErrorEnvelope> {
  const owner = new Map<string, CapabilityModule>();
  const byName = new Map<string, ToolDefinition>();
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
  }

  const enabled = (module: CapabilityModule, homeId: HomeId) => module.enabledFor?.(homeId) ?? true;
  return ok({
    moduleIds: [...ids],
    toolsFor: (homeId) => modules.filter((m) => enabled(m, homeId)).flatMap((m) => m.tools),
    findTool: (name, homeId) => {
      const module = owner.get(name);
      return module && enabled(module, homeId) ? byName.get(name) : undefined;
    },
  });
}
