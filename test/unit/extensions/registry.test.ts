/**
 * Unit tests for ExtensionRegistry
 *
 * Tests the extension registry for storing, indexing, and querying extensions.
 *
 * @source @src/extensions/registry.ts
 * @architecture @docs/architecture/cli/extending-cli.md
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ExtensionRegistry, createRegistry, getRegistry } from '../../../src/extensions/registry.js';
import type { Extension, ExtensionType } from '../../../src/extensions/types.js';

describe('ExtensionRegistry', () => {
  let registry: ExtensionRegistry;

  // Test fixture: minimal valid extension
  const createTestExtension = (id: string, type: ExtensionType = 'command'): Extension => ({
    id,
    type,
    name: `Test ${id}`,
    description: `Test extension ${id}`,
    version: '1.0.0',
    capabilities: ['test-capability'],
    keywords: ['test', 'keyword'],
    platforms: {
      claude: 'full',
    },
    deployment: {
      pathTemplate: '.claude/commands/{id}.md',
    },
    metadata: {
      type: 'command',
      template: 'utility',
    },
  });

  beforeEach(() => {
    registry = createRegistry();
  });

  describe('register()', () => {
    it('should register extensions and maintain indices', () => {
      // Register a single extension
      const ext1 = createTestExtension('test-cmd');
      registry.register(ext1);
      expect(registry.has('test-cmd')).toBe(true);
      expect(registry.size).toBe(1);

      // Verify stored values match
      const retrieved = registry.get('test-cmd');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('test-cmd');
      expect(retrieved?.name).toBe('Test test-cmd');

      // Overwrite should replace, not duplicate
      const ext2 = { ...ext1, name: 'Updated Name' };
      registry.register(ext2);
      expect(registry.size).toBe(1);
      expect(registry.get('test-cmd')?.name).toBe('Updated Name');
    });

    it('should index extensions by type and handle multiple entries', () => {
      const cmd = createTestExtension('test-cmd', 'command');
      const agent = createTestExtension('test-agent', 'agent');
      registry.register(cmd);
      registry.register(agent);

      // Single type retrieval
      const commands = registry.getByType('command');
      expect(commands).toHaveLength(1);
      expect(commands[0].id).toBe('test-cmd');

      // Multiple extensions of same type
      const cmd2 = createTestExtension('cmd-2', 'command');
      const cmd3 = createTestExtension('cmd-3', 'command');
      registry.register(cmd2);
      registry.register(cmd3);

      const allCommands = registry.getByType('command');
      expect(allCommands).toHaveLength(3);
      expect(allCommands.map((c) => c.id).sort()).toEqual(['cmd-2', 'cmd-3', 'test-cmd']);
    });

    it('should register command aliases from metadata', () => {
      const ext = createTestExtension('mention-wire', 'command');
      (ext.metadata as any).aliases = ['wire', 'link'];
      registry.register(ext);

      // All aliases should resolve to primary ID
      const aliasesToTest = ['wire', 'link', 'mention-wire'];
      for (const alias of aliasesToTest) {
        expect(registry.resolveCommand(alias)).toBe('mention-wire');
      }
    });
  });

  describe('get() and has()', () => {
    it('should retrieve registered extensions and report existence correctly', () => {
      const ext = createTestExtension('test-cmd');
      registry.register(ext);

      // get() returns the extension
      const retrieved = registry.get('test-cmd');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('test-cmd');

      // has() reports true for registered
      expect(registry.has('test-cmd')).toBe(true);

      // Both return false/undefined for non-existent
      expect(registry.get('non-existent')).toBeUndefined();
      expect(registry.has('non-existent')).toBe(false);
    });
  });

  describe('getByType()', () => {
    it('should filter extensions by type', () => {
      // Empty type returns empty array
      expect(registry.getByType('agent')).toEqual([]);

      // Register mixed types
      registry.register(createTestExtension('cmd-1', 'command'));
      registry.register(createTestExtension('agent-1', 'agent'));
      registry.register(createTestExtension('cmd-2', 'command'));
      registry.register(createTestExtension('skill-1', 'skill'));

      // Filter returns only matching type
      const commands = registry.getByType('command');
      expect(commands).toHaveLength(2);
      expect(commands.every((e) => e.type === 'command')).toBe(true);
    });

    it('should support all extension types', () => {
      const types: ExtensionType[] = [
        'agent',
        'command',
        'skill',
        'hook',
        'tool',
        'mcp-server',
        'framework',
        'addon',
        'template',
        'prompt',
      ];

      // Register one of each type
      for (const type of types) {
        registry.register(createTestExtension(`test-${type}`, type));
      }

      // Verify all types are retrievable
      for (const type of types) {
        const results = registry.getByType(type);
        expect(results).toHaveLength(1);
        expect(results[0].type).toBe(type);
      }
    });
  });

  describe('resolveCommand() and registerAlias()', () => {
    it('should resolve commands by primary ID and aliases', () => {
      const ext = createTestExtension('mention-wire', 'command');
      registry.register(ext);

      // Primary ID resolves
      expect(registry.resolveCommand('mention-wire')).toBe('mention-wire');

      // Unknown command returns undefined
      expect(registry.resolveCommand('unknown-cmd')).toBeUndefined();

      // Register an alias
      registry.registerAlias('wire', 'mention-wire');
      expect(registry.resolveCommand('wire')).toBe('mention-wire');

      // Overwriting alias updates resolution
      registry.registerAlias('wire', 'new-command');
      expect(registry.resolveCommand('wire')).toBe('new-command');
    });

    it('should handle multiple aliases for same command', () => {
      const aliases = ['w', 'wire', 'link'];

      // Register all aliases
      for (const alias of aliases) {
        registry.registerAlias(alias, 'mention-wire');
      }

      // Verify all resolve correctly
      for (const alias of aliases) {
        expect(registry.resolveCommand(alias)).toBe('mention-wire');
      }
    });
  });

  describe('getAll()', () => {
    it('should return all registered extensions as a new array', () => {
      // Empty registry
      expect(registry.getAll()).toEqual([]);

      // Register multiple
      registry.register(createTestExtension('ext-1', 'command'));
      registry.register(createTestExtension('ext-2', 'agent'));
      registry.register(createTestExtension('ext-3', 'skill'));

      const all = registry.getAll();
      expect(all).toHaveLength(3);
      expect(all.map((e) => e.id).sort()).toEqual(['ext-1', 'ext-2', 'ext-3']);

      // Each call returns a new array instance
      const all2 = registry.getAll();
      expect(all).not.toBe(all2);
      expect(all).toEqual(all2);
    });
  });

  describe('size', () => {
    it('should track the number of registered extensions', () => {
      expect(registry.size).toBe(0);

      registry.register(createTestExtension('ext-1'));
      expect(registry.size).toBe(1);

      registry.register(createTestExtension('ext-2'));
      expect(registry.size).toBe(2);

      registry.register(createTestExtension('ext-3'));
      expect(registry.size).toBe(3);

      // Overwriting should not increase size
      registry.register(createTestExtension('ext-1'));
      expect(registry.size).toBe(3);
    });
  });

  describe('clear()', () => {
    it('should clear all extensions, type index, and alias map', () => {
      registry.register(createTestExtension('cmd-1', 'command'));
      registry.register(createTestExtension('agent-1', 'agent'));
      registry.registerAlias('wire', 'mention-wire');
      registry.registerAlias('link', 'mention-wire');

      expect(registry.size).toBe(2);

      registry.clear();

      // Main registry cleared
      expect(registry.size).toBe(0);
      expect(registry.getAll()).toEqual([]);

      // Type index cleared
      expect(registry.getByType('command')).toEqual([]);
      expect(registry.getByType('agent')).toEqual([]);

      // Alias map cleared
      expect(registry.resolveCommand('wire')).toBeUndefined();
      expect(registry.resolveCommand('link')).toBeUndefined();
    });
  });

  describe('type index integrity', () => {
    it('should maintain type index correctly when registering and overwriting', () => {
      // Register multiple types
      registry.register(createTestExtension('cmd-1', 'command'));
      registry.register(createTestExtension('agent-1', 'agent'));
      registry.register(createTestExtension('skill-1', 'skill'));
      registry.register(createTestExtension('cmd-2', 'command'));

      expect(registry.getByType('command')).toHaveLength(2);
      expect(registry.getByType('agent')).toHaveLength(1);
      expect(registry.getByType('skill')).toHaveLength(1);

      // Overwrite with different type updates index
      registry.register(createTestExtension('cmd-1', 'agent'));

      expect(registry.getByType('command')).toHaveLength(1);
      expect(registry.getByType('agent')).toHaveLength(2);
    });
  });

  describe('O(1) performance characteristics', () => {
    it('should provide O(1) lookup by ID', () => {
      // Register many extensions
      for (let i = 0; i < 1000; i++) {
        registry.register(createTestExtension(`ext-${i}`));
      }

      // Lookup is O(1) via Map. Average over many calls across the full key
      // range so a single GC/JIT spike on a loaded CI runner can't flake an
      // absolute sub-millisecond bound (a single timed get hit 2ms on CI).
      const ITERATIONS = 1000;
      const start = performance.now();
      let result: ReturnType<typeof registry.get> | undefined;
      for (let i = 0; i < ITERATIONS; i++) {
        result = registry.get(`ext-${i}`);
      }
      const avgDuration = (performance.now() - start) / ITERATIONS;

      expect(result).toBeDefined();
      expect(avgDuration).toBeLessThan(1); // ~constant per-op; averaging removes spikes
    });

    it('should provide O(1) command resolution', () => {
      // Register many aliases
      for (let i = 0; i < 1000; i++) {
        registry.registerAlias(`alias-${i}`, `command-${i}`);
      }

      // Resolution should be fast (O(1) via Map)
      const start = performance.now();
      const result = registry.resolveCommand('alias-500');
      const duration = performance.now() - start;

      expect(result).toBe('command-500');
      expect(duration).toBeLessThan(1); // Should be nearly instant
    });
  });
});

describe('createRegistry()', () => {
  it('should create independent registry instances', () => {
    const reg1 = createRegistry();
    const reg2 = createRegistry();

    // Different instances
    expect(reg1).not.toBe(reg2);
    expect(reg1).toBeInstanceOf(ExtensionRegistry);
    expect(reg2).toBeInstanceOf(ExtensionRegistry);

    // Truly independent state
    const ext = {
      id: 'test-cmd',
      type: 'command' as const,
      name: 'Test',
      description: 'Test',
      version: '1.0.0',
      capabilities: [],
      keywords: [],
      platforms: {},
      deployment: { pathTemplate: '' },
      metadata: { type: 'command' as const, template: 'utility' as const },
    };

    reg1.register(ext);

    expect(reg1.has('test-cmd')).toBe(true);
    expect(reg2.has('test-cmd')).toBe(false);
  });
});

describe('getRegistry()', () => {
  it('should return a singleton instance that shares state', () => {
    const reg1 = getRegistry();
    const reg2 = getRegistry();

    // Singleton pattern
    expect(reg1).toBe(reg2);
    expect(reg1).toBeInstanceOf(ExtensionRegistry);

    // Shared state across calls
    const ext = {
      id: 'test-cmd',
      type: 'command' as const,
      name: 'Test',
      description: 'Test',
      version: '1.0.0',
      capabilities: [],
      keywords: [],
      platforms: {},
      deployment: { pathTemplate: '' },
      metadata: { type: 'command' as const, template: 'utility' as const },
    };

    reg1.register(ext);

    const reg3 = getRegistry();
    expect(reg3.has('test-cmd')).toBe(true);
  });
});
