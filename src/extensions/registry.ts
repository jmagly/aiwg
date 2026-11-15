/**
 * Extension Registry
 *
 * Provides efficient storage, indexing, and retrieval of AIWG extensions.
 * Supports O(1) lookup by ID, type-based indexing, and command alias resolution.
 *
 * @architecture @docs/architecture/cli/extending-cli.md
 * @tests @test/unit/extensions/registry.test.ts
 * @version 1.0.0
 */

import type { Extension, ExtensionType } from './types.js';

/**
 * Extension registry for storing and querying extensions
 *
 * Maintains multiple indexes for efficient lookup:
 * - Primary storage: Map<id, Extension> for O(1) lookup by ID
 * - Type index: Map<type, Set<id>> for filtering by type
 * - Alias map: Map<alias, id> for command resolution
 *
 * @example
 * ```typescript
 * const registry = new ExtensionRegistry();
 *
 * // Register an extension
 * registry.register(myExtension);
 *
 * // Lookup by ID (O(1))
 * const ext = registry.get('mention-wire');
 *
 * // Get all commands
 * const commands = registry.getByType('command');
 *
 * // Resolve command alias
 * const id = registry.resolveCommand('wire'); // Returns 'mention-wire'
 * ```
 */
export class ExtensionRegistry {
  /**
   * Primary storage: extension ID to Extension
   *
   * Provides O(1) lookup by ID.
   */
  private extensions: Map<string, Extension> = new Map();

  /**
   * Type index: extension type to Set of extension IDs
   *
   * Enables efficient filtering by type.
   */
  private byType: Map<ExtensionType, Set<string>> = new Map();

  /**
   * Alias map: command alias to extension ID
   *
   * Enables O(1) command resolution by name or alias.
   */
  private aliasMap: Map<string, string> = new Map();

  /**
   * Qualified name map: `{namespace}-{id}` to extension ID
   *
   * Enables lookup by canonical namespaced slug (e.g. `aiwg-sync` → `sync`).
   * Only populated for skills/commands that carry a `namespace` field.
   */
  private qualifiedNameMap: Map<string, string> = new Map();

  /**
   * Register an extension in the registry
   *
   * If an extension with the same ID already exists, it will be replaced.
   * Automatically updates type index and registers command aliases.
   *
   * @param extension - Extension to register
   *
   * @example
   * ```typescript
   * registry.register({
   *   id: 'mention-wire',
   *   type: 'command',
   *   name: 'Mention Wire',
   *   // ... other fields
   * });
   * ```
   */
  register(extension: Extension): void {
    const { id } = extension;

    // If extension already exists, remove it from old type index
    const existing = this.extensions.get(id);
    if (existing) {
      this.removeFromTypeIndex(existing);
    }

    // Store extension
    this.extensions.set(id, extension);

    // Add to type index
    this.addToTypeIndex(extension);

    // Register command aliases if present
    if ((extension.type === 'command' || extension.type === 'skill') && 'aliases' in extension.metadata) {
      const aliases = (extension.metadata as any).aliases;
      if (Array.isArray(aliases)) {
        aliases.forEach((alias: string) => {
          this.registerAlias(alias, id);
        });
      }
    }

    // Register primary command/skill name
    if (extension.type === 'command' || extension.type === 'skill') {
      this.aliasMap.set(id, id);
    }

    // Register qualified name for namespaced skills/commands
    if ((extension.type === 'skill' || extension.type === 'command') && 'namespace' in extension.metadata) {
      const namespace = (extension.metadata as any).namespace as string | undefined;
      if (namespace) {
        const prefix = `${namespace}-`;
        const qualifiedName = id.startsWith(prefix) ? id : `${prefix}${id}`;
        this.qualifiedNameMap.set(qualifiedName, id);
      }
    }
  }

  /**
   * Get extension by ID
   *
   * O(1) lookup via Map.
   *
   * @param id - Extension ID
   * @returns Extension if found, undefined otherwise
   *
   * @example
   * ```typescript
   * const ext = registry.get('mention-wire');
   * if (ext) {
   *   console.log(ext.name);
   * }
   * ```
   */
  get(id: string): Extension | undefined {
    return this.extensions.get(id);
  }

  /**
   * Get all extensions of a specific type
   *
   * Uses type index for efficient filtering.
   *
   * @param type - Extension type to filter by
   * @returns Array of extensions of the specified type
   *
   * @example
   * ```typescript
   * const commands = registry.getByType('command');
   * const agents = registry.getByType('agent');
   * ```
   */
  getByType(type: ExtensionType): Extension[] {
    const ids = this.byType.get(type);
    if (!ids || ids.size === 0) {
      return [];
    }

    const extensions: Extension[] = [];
    for (const id of ids) {
      const ext = this.extensions.get(id);
      if (ext) {
        extensions.push(ext);
      }
    }

    return extensions;
  }

  /**
   * Resolve a command name or alias to extension ID
   *
   * O(1) lookup via Map.
   *
   * @param command - Command name or alias
   * @returns Extension ID if found, undefined otherwise
   *
   * @example
   * ```typescript
   * const id = registry.resolveCommand('wire'); // 'mention-wire'
   * const ext = registry.get(id);
   * ```
   */
  resolveCommand(command: string): string | undefined {
    return this.aliasMap.get(command);
  }

  /**
   * Register a command alias
   *
   * Associates an alias with an extension ID. The extension does not
   * need to be registered first.
   *
   * @param alias - Command alias
   * @param extensionId - Target extension ID
   *
   * @example
   * ```typescript
   * registry.registerAlias('wire', 'mention-wire');
   * registry.registerAlias('w', 'mention-wire');
   * ```
   */
  registerAlias(alias: string, extensionId: string): void {
    this.aliasMap.set(alias, extensionId);
  }

  /**
   * Resolve a qualified namespaced name to an extension ID.
   *
   * Accepts either the canonical qualified slug (`aiwg-sync`) or the bare ID (`sync`).
   * Falls back to bare ID lookup when no qualified name match is found.
   *
   * @param qualifiedName - Qualified skill name (e.g. `aiwg-sync`) or bare ID
   * @returns Extension ID if found, undefined otherwise
   *
   * @example
   * ```typescript
   * const id = registry.resolveQualifiedName('aiwg-sync'); // 'sync'
   * const ext = registry.get(id);
   * ```
   */
  resolveQualifiedName(qualifiedName: string): string | undefined {
    return this.qualifiedNameMap.get(qualifiedName) ?? this.extensions.get(qualifiedName)?.id;
  }

  /**
   * Get all registered extensions
   *
   * Returns a new array containing all extensions. Modifications to the
   * returned array will not affect the registry.
   *
   * @returns Array of all extensions
   *
   * @example
   * ```typescript
   * const all = registry.getAll();
   * console.log(`Registry contains ${all.length} extensions`);
   * ```
   */
  getAll(): Extension[] {
    return Array.from(this.extensions.values());
  }

  /**
   * Get count of registered extensions
   *
   * @returns Number of extensions in the registry
   *
   * @example
   * ```typescript
   * console.log(`${registry.size} extensions registered`);
   * ```
   */
  get size(): number {
    return this.extensions.size;
  }

  /**
   * Check if extension exists in registry
   *
   * O(1) lookup via Map.
   *
   * @param id - Extension ID to check
   * @returns True if extension exists, false otherwise
   *
   * @example
   * ```typescript
   * if (registry.has('mention-wire')) {
   *   console.log('Extension is registered');
   * }
   * ```
   */
  has(id: string): boolean {
    return this.extensions.has(id);
  }

  /**
   * Clear the registry
   *
   * Removes all extensions, type index entries, and aliases.
   *
   * @example
   * ```typescript
   * registry.clear();
   * console.log(registry.size); // 0
   * ```
   */
  clear(): void {
    this.extensions.clear();
    this.byType.clear();
    this.aliasMap.clear();
    this.qualifiedNameMap.clear();
  }

  /**
   * Add extension to type index
   *
   * @private
   * @param extension - Extension to index
   */
  private addToTypeIndex(extension: Extension): void {
    const { id, type } = extension;

    let typeSet = this.byType.get(type);
    if (!typeSet) {
      typeSet = new Set();
      this.byType.set(type, typeSet);
    }

    typeSet.add(id);
  }

  /**
   * Remove extension from type index
   *
   * @private
   * @param extension - Extension to remove from index
   */
  private removeFromTypeIndex(extension: Extension): void {
    const { id, type } = extension;

    const typeSet = this.byType.get(type);
    if (typeSet) {
      typeSet.delete(id);

      // Clean up empty sets
      if (typeSet.size === 0) {
        this.byType.delete(type);
      }
    }
  }
}

// ============================================
// Singleton Instance
// ============================================

/**
 * Global registry instance
 *
 * Singleton instance shared across all calls to getRegistry().
 */
let globalRegistry: ExtensionRegistry | null = null;

/**
 * Get the global registry instance
 *
 * Returns a singleton ExtensionRegistry instance. All calls to this
 * function return the same instance, allowing state to be shared
 * across the application.
 *
 * @returns Global ExtensionRegistry instance
 *
 * @example
 * ```typescript
 * import { getRegistry } from './registry.js';
 *
 * const registry = getRegistry();
 * registry.register(myExtension);
 *
 * // Later, in another module
 * const sameRegistry = getRegistry();
 * console.log(sameRegistry.has('my-extension')); // true
 * ```
 */
export function getRegistry(): ExtensionRegistry {
  if (!globalRegistry) {
    globalRegistry = new ExtensionRegistry();
  }
  return globalRegistry;
}

/**
 * Create a new registry instance
 *
 * Returns a new, independent ExtensionRegistry instance. Use this when
 * you need an isolated registry for testing or scoped operations.
 *
 * @returns New ExtensionRegistry instance
 *
 * @example
 * ```typescript
 * import { createRegistry } from './registry.js';
 *
 * const testRegistry = createRegistry();
 * testRegistry.register(testExtension);
 * // testRegistry is independent of global registry
 * ```
 */
export function createRegistry(): ExtensionRegistry {
  return new ExtensionRegistry();
}
