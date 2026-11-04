/**
 * Extension Loader Tests
 *
 * @implements @.aiwg/requirements/use-cases/UC-004-extension-system.md
 * @source @src/extensions/loader.ts
 * @tests Unit tests for extension registry loading
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadRegistry, getLoadedRegistry, linkHandlers } from '../../../src/extensions/loader.js';
import { createRegistry } from '../../../src/extensions/registry.js';
import type { CommandHandler } from '../../../src/cli/handlers/types.js';
import type { Extension, CommandMetadata } from '../../../src/extensions/types.js';

describe('loader', () => {
  describe('loadRegistry', () => {
    it('accepts entry-command handlers without requiring the complete handler table', async () => {
      const { discoverHandler } = await import('../../../src/cli/handlers/subcommands-discovery.js');
      const result = await loadRegistry({ handlers: [discoverHandler] });
      expect(result.registry.resolveCommand('discover')).toBe('discover');
      expect([...result.handlerMap.keys()]).toEqual(['discover']);
      // Partial entry initialization must not poison a later normal registry.
      expect((await loadRegistry()).handlerMap.has('help')).toBe(true);
    });

    it('should load command definitions into a new registry', async () => {
      const result = await loadRegistry();

      expect(result.registry).toBeDefined();
      expect(result.handlerMap).toBeDefined();
      expect(result.registry.size).toBeGreaterThan(0);
    });

    it('should use provided registry instance', async () => {
      const customRegistry = createRegistry();
      const result = await loadRegistry({ registry: customRegistry });

      expect(result.registry).toBe(customRegistry);
    });

    it('should register command aliases', async () => {
      const result = await loadRegistry();
      const { registry } = result;

      // help command has aliases: ['-h', '-help', '--help']
      expect(registry.resolveCommand('-h')).toBe('help');
      expect(registry.resolveCommand('-help')).toBe('help');
      expect(registry.resolveCommand('--help')).toBe('help');
      expect(registry.resolveCommand('help')).toBe('help');
    });

    it('should build capability index when requested', async () => {
      const result = await loadRegistry({ indexCapabilities: true });

      expect(result.capabilityIndex).toBeDefined();
      expect(result.capabilityIndex?.capabilityCount).toBeGreaterThan(0);
    });

    it('should not build capability index by default', async () => {
      const result = await loadRegistry();

      expect(result.capabilityIndex).toBeUndefined();
    });

    it('should link handlers to definitions by ID', async () => {
      const result = await loadRegistry();

      // Check that handler map contains entries
      expect(result.handlerMap.size).toBeGreaterThan(0);

      // Verify help handler is linked
      const helpHandler = result.handlerMap.get('help');
      expect(helpHandler).toBeDefined();
      expect(helpHandler?.id).toBe('help');
    });

    it('should register commands by type', async () => {
      const result = await loadRegistry();
      const commands = result.registry.getByType('skill');

      expect(commands.length).toBeGreaterThan(0);
      expect(commands[0].type).toBe('skill');
    });
  });

  describe('getLoadedRegistry', () => {
    it('should return a loaded registry instance', async () => {
      const result = await getLoadedRegistry();

      expect(result.registry).toBeDefined();
      expect(result.handlerMap).toBeDefined();
      expect(result.registry.size).toBeGreaterThan(0);
    });

    it('should use global registry instance', async () => {
      const first = await getLoadedRegistry();
      const second = await getLoadedRegistry();

      // Same singleton instance
      expect(first.registry).toBe(second.registry);
    });
  });

  describe('linkHandlers', () => {
    it('should create handler map from handlers array', () => {
      const mockHandlers: CommandHandler[] = [
        {
          id: 'test-command',
          name: 'Test',
          description: 'Test command',
          category: 'utility',
          aliases: ['tc'],
          async execute() {
            return { exitCode: 0 };
          },
        },
        {
          id: 'another-command',
          name: 'Another',
          description: 'Another command',
          category: 'utility',
          aliases: ['ac'],
          async execute() {
            return { exitCode: 0 };
          },
        },
      ];

      const handlerMap = linkHandlers(mockHandlers as any);

      expect(handlerMap.size).toBe(2);
      expect(handlerMap.get('test-command')).toBeDefined();
      expect(handlerMap.get('another-command')).toBeDefined();
    });

    it('should handle empty handlers array', () => {
      const handlerMap = linkHandlers([] as any);

      expect(handlerMap.size).toBe(0);
    });

    it('should link by handler ID', () => {
      const mockHandler: CommandHandler = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        category: 'utility',
        aliases: [],
        async execute() {
          return { exitCode: 0 };
        },
      };

      const handlerMap = linkHandlers([mockHandler] as any);

      expect(handlerMap.get('test')).toBe(mockHandler);
    });
  });

  describe('integration', () => {
    it('should allow command resolution and handler lookup', async () => {
      const result = await loadRegistry();

      // Resolve command alias to ID
      const commandId = result.registry.resolveCommand('-h');
      expect(commandId).toBe('help');

      // Get extension definition
      const extension = result.registry.get(commandId!);
      expect(extension).toBeDefined();
      expect(extension?.type).toBe('skill');

      // Get handler
      const handler = result.handlerMap.get(commandId!);
      expect(handler).toBeDefined();
      expect(handler?.id).toBe('help');
    });

    it('should support capability queries with index', async () => {
      const result = await loadRegistry({ indexCapabilities: true });

      // Find all commands with cli capability
      const cliCommands = result.capabilityIndex!.getByCapability('cli');
      expect(cliCommands.length).toBeGreaterThan(0);
    });

    it('should handle command with metadata correctly', async () => {
      const result = await loadRegistry();

      // Get a skill extension (formerly command)
      const skills = result.registry.getByType('skill');
      expect(skills.length).toBeGreaterThan(0);

      const helpCommand = skills.find(c => c.id === 'help');
      expect(helpCommand).toBeDefined();
      expect(helpCommand?.metadata.type).toBe('skill');

      const metadata = helpCommand?.metadata as { commandHint?: CommandMetadata };
      expect(metadata.commandHint).toBeDefined();
    });
  });
});
