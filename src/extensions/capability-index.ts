/**
 * CapabilityIndex - Capability-based extension discovery system
 *
 * @implements @.aiwg/requirements/use-cases/UC-004-extension-system.md
 * @architecture @docs/architecture/cli/index.md
 * @tests @test/unit/extensions/capability-index.test.ts
 */

import type { Extension } from './types.js';

/**
 * Query structure for capability-based extension search
 */
export interface CapabilityQuery {
  /** Find extensions with ALL these capabilities */
  all?: string[];
  /** Find extensions with ANY of these capabilities */
  any?: string[];
  /** Exclude extensions with these capabilities */
  not?: string[];
  /** Filter by extension type */
  type?: string;
}

/**
 * CapabilityIndex enables finding extensions by what they can do.
 *
 * Maintains bidirectional mappings:
 * - capability → extension IDs (for queries)
 * - extension ID → capabilities (for updates)
 *
 * @example
 * ```typescript
 * const index = new CapabilityIndex();
 * index.index(myExtension);
 *
 * // Find extensions that can format markdown
 * const formatters = index.getByCapability('format:markdown');
 *
 * // Find extensions that can format OR lint
 * const tools = index.query({ any: ['format:markdown', 'lint:markdown'] });
 *
 * // Find formatters that are NOT linters
 * const pureFormatters = index.query({
 *   all: ['format:markdown'],
 *   not: ['lint:markdown']
 * });
 * ```
 */
export class CapabilityIndex {
  /** Map of capability → extension IDs */
  private byCapability: Map<string, Set<string>> = new Map();

  /** Map of extension ID → capabilities */
  private byExtension: Map<string, Set<string>> = new Map();

  /** Map of extension ID → extension type */
  private extensionTypes: Map<string, string> = new Map();

  /**
   * Index an extension's capabilities for fast lookup.
   *
   * @param extension - Extension to index
   *
   * @example
   * ```typescript
   * index.index({
   *   id: 'markdown-formatter',
   *   type: 'tool',
   *   capabilities: ['format:markdown', 'format:commonmark']
   * });
   * ```
   */
  index(extension: Extension): void {
    const extensionId = extension.id;
    const capabilities = extension.capabilities || [];

    // Store extension type
    this.extensionTypes.set(extensionId, extension.type);

    // Remove old mappings if re-indexing
    this.remove(extensionId);

    // Store extension → capabilities mapping
    this.byExtension.set(extensionId, new Set(capabilities));

    // Add to capability → extensions mappings
    for (const capability of capabilities) {
      if (!this.byCapability.has(capability)) {
        this.byCapability.set(capability, new Set());
      }
      this.byCapability.get(capability)!.add(extensionId);
    }
  }

  /**
   * Remove an extension from the index.
   *
   * @param extensionId - ID of extension to remove
   *
   * @example
   * ```typescript
   * index.remove('markdown-formatter');
   * ```
   */
  remove(extensionId: string): void {
    // Get capabilities for this extension
    const capabilities = this.byExtension.get(extensionId);
    if (!capabilities) {
      return; // Not indexed
    }

    // Remove from capability → extensions mappings
    const capabilityArray = Array.from(capabilities);
    for (const capability of capabilityArray) {
      const extensions = this.byCapability.get(capability);
      if (extensions) {
        extensions.delete(extensionId);
        // Clean up empty sets
        if (extensions.size === 0) {
          this.byCapability.delete(capability);
        }
      }
    }

    // Remove extension → capabilities mapping
    this.byExtension.delete(extensionId);

    // Remove extension type
    this.extensionTypes.delete(extensionId);
  }

  /**
   * Query extensions by capabilities.
   *
   * Query logic:
   * 1. Start with all extensions if no `all` or `any` specified
   * 2. Filter to extensions with ALL capabilities in `all` array
   * 3. Filter to extensions with ANY capability in `any` array
   * 4. Exclude extensions with capabilities in `not` array
   * 5. Optionally filter by extension type
   *
   * @param query - Capability query
   * @returns Array of matching extension IDs
   *
   * @example
   * ```typescript
   * // Extensions that can do BOTH formatting and validation
   * index.query({ all: ['format:markdown', 'validate:markdown'] });
   *
   * // Extensions that can do EITHER formatting or linting
   * index.query({ any: ['format:markdown', 'lint:markdown'] });
   *
   * // Formatters that are NOT linters
   * index.query({
   *   all: ['format:markdown'],
   *   not: ['lint:markdown']
   * });
   *
   * // Only tool-type extensions with formatting capability
   * index.query({
   *   all: ['format:markdown'],
   *   type: 'tool'
   * });
   * ```
   */
  query(query: CapabilityQuery): string[] {
    let candidates: Set<string>;

    // Phase 1: Build initial candidate set
    if (query.all && query.all.length > 0) {
      // Start with extensions that have the first required capability
      const firstCapability = this.byCapability.get(query.all[0]);
      candidates = firstCapability ? new Set(firstCapability) : new Set();

      // Intersect with extensions that have ALL other required capabilities
      for (let i = 1; i < query.all.length; i++) {
        const withCapability = this.byCapability.get(query.all[i]);
        if (!withCapability || withCapability.size === 0) {
          // If any required capability has no extensions, result is empty
          return [];
        }

        // Keep only extensions that have this capability too
        const candidateArray = Array.from(candidates);
        candidates = new Set(
          candidateArray.filter(id => withCapability.has(id))
        );

        if (candidates.size === 0) {
          // Early exit if intersection is empty
          return [];
        }
      }
    } else if (query.any && query.any.length > 0) {
      // Union of extensions with ANY of the specified capabilities
      candidates = new Set();
      for (const capability of query.any) {
        const withCapability = this.byCapability.get(capability);
        if (withCapability) {
          const capabilityArray = Array.from(withCapability);
          for (const id of capabilityArray) {
            candidates.add(id);
          }
        }
      }
    } else {
      // No constraints - start with all extensions
      candidates = new Set(this.byExtension.keys());
    }

    // Phase 2: Apply exclusions
    if (query.not && query.not.length > 0) {
      for (const capability of query.not) {
        const toExclude = this.byCapability.get(capability);
        if (toExclude) {
          const excludeArray = Array.from(toExclude);
          for (const id of excludeArray) {
            candidates.delete(id);
          }
        }
      }
    }

    // Phase 3: Filter by type
    if (query.type) {
      const candidateArray = Array.from(candidates);
      candidates = new Set(
        candidateArray.filter(id => this.extensionTypes.get(id) === query.type)
      );
    }

    return Array.from(candidates).sort();
  }

  /**
   * Get all capabilities in the index.
   *
   * @returns Sorted array of capability strings
   *
   * @example
   * ```typescript
   * const capabilities = index.getAllCapabilities();
   * // ['format:markdown', 'lint:markdown', 'validate:markdown']
   * ```
   */
  getAllCapabilities(): string[] {
    return Array.from(this.byCapability.keys()).sort();
  }

  /**
   * Get all extensions with a specific capability.
   *
   * @param capability - Capability to search for
   * @returns Sorted array of extension IDs
   *
   * @example
   * ```typescript
   * const formatters = index.getByCapability('format:markdown');
   * // ['markdown-formatter', 'prettier-markdown']
   * ```
   */
  getByCapability(capability: string): string[] {
    const extensions = this.byCapability.get(capability);
    return extensions ? Array.from(extensions).sort() : [];
  }

  /**
   * Check if a capability exists in the index.
   *
   * @param capability - Capability to check
   * @returns True if at least one extension has this capability
   *
   * @example
   * ```typescript
   * if (index.hasCapability('format:markdown')) {
   *   console.log('Markdown formatting available');
   * }
   * ```
   */
  hasCapability(capability: string): boolean {
    const extensions = this.byCapability.get(capability);
    return extensions !== undefined && extensions.size > 0;
  }

  /**
   * Get the number of unique capabilities in the index.
   *
   * @example
   * ```typescript
   * console.log(`Indexed ${index.capabilityCount} capabilities`);
   * ```
   */
  get capabilityCount(): number {
    return this.byCapability.size;
  }

  /**
   * Clear all indexed data.
   *
   * @example
   * ```typescript
   * index.clear();
   * // All mappings reset
   * ```
   */
  clear(): void {
    this.byCapability.clear();
    this.byExtension.clear();
    this.extensionTypes.clear();
  }
}
