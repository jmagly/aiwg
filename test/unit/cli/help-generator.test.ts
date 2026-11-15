/**
 * Tests for Help Generator
 *
 * @source @src/cli/help-generator.ts
 * @implements @docs/architecture/cli/adr-001-unified-extension-registry.md
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { generateHelp } from '../../../src/cli/help-generator.js';
import { createRegistry } from '../../../src/extensions/registry.js';
import type { Extension } from '../../../src/extensions/types.js';

describe('generateHelp', () => {
  let registry: ReturnType<typeof createRegistry>;

  beforeEach(() => {
    registry = createRegistry();
  });

  describe('basic structure', () => {
    it('should generate header and usage', () => {
      const help = generateHelp(registry);

      expect(help).toContain('AIWG CLI');
      expect(help).toContain('Usage: aiwg <command> [options]');
    });

    it('should include platform options section', () => {
      const help = generateHelp(registry);

      expect(help).toContain('Platform Options');
      expect(help).toContain('copilot');
      expect(help).toContain('factory');
      expect(help).toContain('openai → codex');
      expect(help).toContain('windsurf');
      expect(help).toContain('cursor');
      expect(help).toContain('opencode');
      expect(help).toContain('warp');
    });

    it('should include examples section', () => {
      const help = generateHelp(registry);

      expect(help).toContain('Examples:');
      expect(help).toContain('aiwg use sdlc');
      expect(help).toContain('aiwg -new');
      expect(help).toContain('aiwg doctor');
    });
  });

  describe('command grouping', () => {
    beforeEach(() => {
      // Add commands across different categories
      registry.register(createMockCommand('use', 'framework', 'Install framework'));
      registry.register(createMockCommand('new', 'project', 'Create new project', ['-new']));
      registry.register(createMockCommand('status', 'workspace', 'Show workspace status'));
      registry.register(createMockCommand('doctor', 'maintenance', 'Check installation health'));
      registry.register(createMockCommand('mcp-serve', 'mcp', 'Start MCP server'));
    });

    it('should group commands by category', () => {
      const help = generateHelp(registry);

      // Check for category headers
      expect(help).toContain('Framework Management:');
      expect(help).toContain('Project Setup:');
      expect(help).toContain('Workspace Management:');
      expect(help).toContain('Maintenance:');
      expect(help).toContain('MCP Server:');
    });

    it('should display commands under correct categories', () => {
      const help = generateHelp(registry);

      // Framework commands
      const frameworkSection = extractSection(help, 'Framework Management:');
      expect(frameworkSection).toContain('use');
      expect(frameworkSection).toContain('Install framework');

      // Project commands
      const projectSection = extractSection(help, 'Project Setup:');
      expect(projectSection).toContain('new');
      expect(projectSection).toContain('Create new project');
    });

    it('should omit empty categories', () => {
      // Registry only has framework commands
      const help = generateHelp(registry);

      // Should not show categories with no commands
      expect(help).not.toContain('Agent Loop (Iterative Execution):');
      expect(help).not.toContain('Channel Management:');
    });

    it('should maintain category order', () => {
      const help = generateHelp(registry);

      const frameworkIdx = help.indexOf('Framework Management:');
      const projectIdx = help.indexOf('Project Setup:');
      const workspaceIdx = help.indexOf('Workspace Management:');
      const mcpIdx = help.indexOf('MCP Server:');
      const maintenanceIdx = help.indexOf('Maintenance:');

      // Verify ordering
      expect(frameworkIdx).toBeGreaterThan(0);
      expect(projectIdx).toBeGreaterThan(frameworkIdx);
      expect(workspaceIdx).toBeGreaterThan(projectIdx);
      expect(mcpIdx).toBeGreaterThan(workspaceIdx);
      expect(maintenanceIdx).toBeGreaterThan(mcpIdx);
    });
  });

  describe('command formatting', () => {
    it('should format command name only', () => {
      registry.register(createMockCommand('use', 'framework', 'Install framework'));

      const help = generateHelp(registry);

      expect(help).toMatch(/\n  use\s+Install framework/);
    });

    it('should format command with primary alias', () => {
      registry.register(createMockCommand('new', 'project', 'Create new project', ['-new']));

      const help = generateHelp(registry);

      // Should show as "new, -new"
      expect(help).toMatch(/\n  new, -new\s+Create new project/);
    });

    it('should format command with multiple aliases', () => {
      registry.register(
        createMockCommand('help', 'maintenance', 'Show help message', ['-h', '-help', '--help'])
      );

      const help = generateHelp(registry);

      // Should show first alias only for brevity
      expect(help).toMatch(/\n  help, -h\s+Show help message/);
    });

    it('should align command descriptions', () => {
      registry.register(createMockCommand('use', 'framework', 'Install framework'));
      registry.register(createMockCommand('list', 'framework', 'List frameworks'));
      registry.register(createMockCommand('remove', 'framework', 'Remove framework'));

      const help = generateHelp(registry);

      const lines = help.split('\n').filter((line) => line.includes('Install framework'));
      expect(lines.length).toBeGreaterThan(0);

      // All command descriptions should start at same column (after padding)
      const frameworkSection = extractSection(help, 'Framework Management:');
      const commandLines = frameworkSection
        .split('\n')
        .filter((line) => line.trim() && !line.includes(':'));

      if (commandLines.length > 1) {
        const descriptionColumns = commandLines.map((line) => {
          const match = line.match(/\s{2}[^\s]+.*?\s{2,}/);
          return match ? match[0].length : 0;
        });

        // All should be padded to similar column
        const maxCol = Math.max(...descriptionColumns);
        expect(maxCol).toBeGreaterThan(0);
      }
    });
  });

  describe('edge cases', () => {
    it('should handle empty registry', () => {
      const help = generateHelp(registry);

      // Should still show structure
      expect(help).toContain('AIWG CLI');
      expect(help).toContain('Usage:');
      expect(help).toContain('Platform Options');
      expect(help).toContain('Examples:');

      // Should not show any category headers
      expect(help).not.toContain('Framework Management:');
      expect(help).not.toContain('Project Setup:');
    });

    it('should handle command with no aliases', () => {
      registry.register(createMockCommand('use', 'framework', 'Install framework', []));

      const help = generateHelp(registry);

      // Should show just the command name
      expect(help).toMatch(/\n  use\s+Install framework/);
    });

    it('should handle command with very long name', () => {
      registry.register(
        createMockCommand(
          'very-long-command-name',
          'utility',
          'Does something complicated',
          []
        )
      );

      const help = generateHelp(registry);

      expect(help).toContain('very-long-command-name');
      expect(help).toContain('Does something complicated');
    });

    it('should handle command with very long description', () => {
      const longDesc =
        'This is a very long description that explains in great detail what this command does';

      registry.register(createMockCommand('test', 'utility', longDesc, []));

      const help = generateHelp(registry);

      expect(help).toContain('test');
      expect(help).toContain(longDesc);
    });
  });

  describe('non-command extensions', () => {
    it('should ignore non-command extensions', () => {
      // Add agent extension
      registry.register(createMockAgent('api-designer'));

      // Add command extension
      registry.register(createMockCommand('use', 'framework', 'Install framework'));

      const help = generateHelp(registry);

      // Should only show command
      expect(help).toContain('use');
      expect(help).not.toContain('api-designer');
    });
  });

  describe('special commands', () => {
    it('should handle Ralph loop commands', () => {
      registry.register(createMockCommand('ralph', 'ralph', 'Execute Ralph loop'));
      registry.register(createMockCommand('ralph-status', 'ralph', 'Check Ralph status'));
      registry.register(createMockCommand('ralph-abort', 'ralph', 'Abort Ralph loop'));

      const help = generateHelp(registry);

      expect(help).toContain('Agent Loop (Iterative Execution):');
      expect(help).toContain('ralph');
      expect(help).toContain('ralph-status');
      expect(help).toContain('ralph-abort');
    });

    it('should handle MCP commands', () => {
      registry.register(createMockCommand('mcp-serve', 'mcp', 'Start MCP server'));
      registry.register(createMockCommand('mcp-install', 'mcp', 'Install MCP config'));
      registry.register(createMockCommand('mcp-info', 'mcp', 'Show MCP info'));

      const help = generateHelp(registry);

      expect(help).toContain('MCP Server:');
      expect(help).toContain('mcp-serve');
      expect(help).toContain('mcp-install');
      expect(help).toContain('mcp-info');
    });

    it('should handle toolsmith commands', () => {
      registry.register(createMockCommand('runtime-info', 'toolsmith', 'Show runtime info'));

      const help = generateHelp(registry);

      expect(help).toContain('Toolsmith (Runtime Discovery):');
      expect(help).toContain('runtime-info');
    });
  });
});

// ============================================
// Test Helpers
// ============================================

/**
 * Create mock command extension for testing
 */
function createMockCommand(
  id: string,
  category: string,
  description: string,
  aliases: string[] = []
): Extension {
  return {
    id,
    type: 'command',
    name: id.charAt(0).toUpperCase() + id.slice(1),
    description,
    version: '1.0.0',
    capabilities: ['cli'],
    keywords: ['command'],
    category,
    platforms: { claude: 'full' },
    deployment: {
      pathTemplate: '.claude/commands/{id}.md',
    },
    metadata: {
      type: 'command',
      template: 'utility',
      aliases,
    },
  };
}

/**
 * Create mock agent extension for testing
 */
function createMockAgent(id: string): Extension {
  return {
    id,
    type: 'agent',
    name: id.charAt(0).toUpperCase() + id.slice(1),
    description: 'Mock agent',
    version: '1.0.0',
    capabilities: ['design'],
    keywords: ['agent'],
    platforms: { claude: 'full' },
    deployment: {
      pathTemplate: '.claude/agents/{id}.md',
    },
    metadata: {
      type: 'agent',
      role: 'Designer',
      model: { tier: 'sonnet' },
      tools: ['Read', 'Write'],
    },
  };
}

/**
 * Extract section from help text for testing
 */
function extractSection(help: string, sectionHeader: string): string {
  const lines = help.split('\n');
  const startIdx = lines.findIndex((line) => line.includes(sectionHeader));

  if (startIdx === -1) return '';

  // Find next section or end
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() && lines[i].match(/^[A-Z]/)) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join('\n');
}
