/**
 * Extension Registry Loader
 *
 * Populates the ExtensionRegistry with command definitions and builds
 * capability indexes for fast lookup.
 *
 * @implements @.aiwg/requirements/use-cases/UC-004-extension-system.md
 * @architecture @.aiwg/architecture/unified-extension-schema.md
 * @tests @test/unit/extensions/loader.test.ts
 */

import { ExtensionRegistry, getRegistry, createRegistry } from './registry.js';
import { CapabilityIndex } from './capability-index.js';
import { commandDefinitions } from './commands/definitions.js';
import type { CommandHandler } from '../cli/handlers/types.js';

/**
 * Loader options
 */
export interface LoaderOptions {
  /**
   * Use existing registry or create new
   *
   * If not provided, a new registry instance is created.
   */
  registry?: ExtensionRegistry;

  /**
   * Include capability indexing
   *
   * @default false
   */
  indexCapabilities?: boolean;

  /** Trusted caller may load only the handlers needed for an entry command. */
  handlers?: readonly CommandHandler[];
}

/**
 * Loaded registry result
 */
export interface LoadedRegistry {
  /** Extension registry with all definitions */
  registry: ExtensionRegistry;

  /** Capability index (if indexCapabilities = true) */
  capabilityIndex?: CapabilityIndex;

  /** Handler map for O(1) handler lookup */
  handlerMap: Map<string, CommandHandler>;
}

/**
 * Load and populate the registry
 *
 * Loads command definitions, registers them with the registry, builds alias
 * map, optionally builds capability index, and links handlers to definitions.
 *
 * @param options - Loader options
 * @returns Loaded registry with handler map
 *
 * @example
 * ```typescript
 * // Load with capability indexing
 * const result = await loadRegistry({ indexCapabilities: true });
 *
 * // Resolve command alias
 * const id = result.registry.resolveCommand('--help'); // 'help'
 *
 * // Get extension definition
 * const ext = result.registry.get(id);
 *
 * // Get handler
 * const handler = result.handlerMap.get(id);
 *
 * // Query by capability
 * const cliCommands = result.capabilityIndex?.getByCapability('cli');
 * ```
 */
export async function loadRegistry(options?: LoaderOptions): Promise<LoadedRegistry> {
  const { registry = createRegistry(), indexCapabilities = false } = options || {};
  const allHandlers = options?.handlers ?? (await import('../cli/handlers/index.js')).allHandlers;

  // Register all command definitions
  for (const definition of commandDefinitions) {
    registry.register(definition);
  }

  // Build alias map from command metadata
  for (const definition of commandDefinitions) {
    if (definition.type === 'command' || definition.type === 'skill') {
      // Find matching handler to get aliases
      const handler = allHandlers.find(h => h.id === definition.id);
      if (handler) {
        // Register all aliases
        for (const alias of handler.aliases) {
          registry.registerAlias(alias, definition.id);
        }
      }
    }
  }

  // Build capability index if requested
  let capabilityIndex: CapabilityIndex | undefined;
  if (indexCapabilities) {
    capabilityIndex = new CapabilityIndex();
    for (const extension of registry.getAll()) {
      capabilityIndex.index(extension);
    }
  }

  // Link handlers to definitions
  const handlerMap = linkHandlers(allHandlers);

  return {
    registry,
    capabilityIndex,
    handlerMap,
  };
}

/**
 * Get the loaded global registry
 *
 * Convenience function for CLI - uses the global singleton registry.
 * This is useful when you want the same registry instance across calls.
 *
 * @returns Loaded registry with handler map
 *
 * @example
 * ```typescript
 * // Get global registry
 * const result = await getLoadedRegistry();
 *
 * // Later, in another module
 * const sameResult = await getLoadedRegistry();
 * // result.registry === sameResult.registry (same instance)
 * ```
 */
export async function getLoadedRegistry(): Promise<LoadedRegistry> {
  const globalRegistry = getRegistry();

  // Check if already loaded
  if (globalRegistry.size === 0) {
    // Load into global registry
    return loadRegistry({ registry: globalRegistry });
  }

  // Already loaded - just build handler map
  const { allHandlers } = await import('../cli/handlers/index.js');
  const handlerMap = linkHandlers(allHandlers);

  return {
    registry: globalRegistry,
    handlerMap,
  };
}

/**
 * Link handlers to command definitions
 *
 * Creates a map from handler ID to handler instance for O(1) lookup.
 * This allows routing from extension definition to handler implementation.
 *
 * @param handlers - Array of command handlers
 * @returns Map of handler ID -> handler
 *
 * @example
 * ```typescript
 * const handlerMap = linkHandlers(allHandlers);
 * const helpHandler = handlerMap.get('help');
 * await helpHandler.execute(ctx);
 * ```
 */
export function linkHandlers(
  handlers: readonly CommandHandler[]
): Map<string, CommandHandler> {
  const handlerMap = new Map<string, CommandHandler>();

  for (const handler of handlers) {
    handlerMap.set(handler.id, handler);
  }

  return handlerMap;
}
