/**
 * Tests for AgentPackager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentPackager } from '../../../src/agents/agent-packager.ts';
import type { AgentInfo } from '../../../src/agents/types.ts';

describe('AgentPackager', () => {
  let packager: AgentPackager;

  beforeEach(() => {
    packager = new AgentPackager();
  });

  const createSampleAgent = (): AgentInfo => ({
    metadata: {
      name: 'test-agent',
      description: 'A test agent for packaging',
      category: 'testing',
      model: 'sonnet',
      tools: ['Read', 'Write', 'Bash'],
      version: '1.0.0',
      dependencies: ['helper-agent'],
    },
    content: '# Test Agent\n\nYou are a test agent.',
    filePath: '/path/to/test-agent.md',
    fileName: 'test-agent.md',
  });

  describe('convertToClaudeFormat', () => {
    it('should convert to Claude Code format with frontmatter and handle minimal metadata', () => {
      // Test full metadata
      const agent = createSampleAgent();
      const result = packager.convertToClaudeFormat(agent);

      expect(result).toContain('---');
      expect(result).toContain('name: test-agent');
      expect(result).toContain('description: A test agent for packaging');
      expect(result).toContain('model: sonnet');
      expect(result).toContain('tools: Read, Write, Bash');
      expect(result).toContain('category: testing');
      expect(result).toContain('version: 1.0.0');
      expect(result).toContain('dependencies: helper-agent');
      expect(result).toContain('# Test Agent');
      expect(result).toContain('You are a test agent.');

      // Test minimal metadata
      const minimalAgent: AgentInfo = {
        metadata: {
          name: 'minimal-agent',
          description: 'Minimal agent',
        },
        content: 'Agent content',
        filePath: '/path/to/minimal.md',
        fileName: 'minimal.md',
      };

      const minimalResult = packager.convertToClaudeFormat(minimalAgent);

      expect(minimalResult).toContain('name: minimal-agent');
      expect(minimalResult).toContain('description: Minimal agent');
      expect(minimalResult).not.toContain('model:');
      expect(minimalResult).not.toContain('tools:');
    });
  });

  describe('convertToAntigravityFormat', () => {
    it('maps generic tools to documented Antigravity identifiers', () => {
      const result = packager.convertToAntigravityFormat(createSampleAgent());

      expect(result).toContain('tools:\n  - view_file\n  - write_to_file\n  - run_command');
      expect(result).not.toContain('tools: Read');
      expect(result).not.toContain('model: sonnet');
    });
  });

  describe('convertToCursorFormat', () => {
    it('should convert to JSON format with lowercased tools and handle minimal metadata', () => {
      // Test full metadata
      const agent = createSampleAgent();
      const result = packager.convertToCursorFormat(agent);
      const parsed = JSON.parse(result);

      expect(parsed.name).toBe('test-agent');
      expect(parsed.description).toBe('A test agent for packaging');
      expect(parsed.prompt).toBe('# Test Agent\n\nYou are a test agent.');
      expect(parsed.tools).toEqual(['read', 'write', 'bash']);
      expect(parsed.tools).not.toContain('Read');
      expect(parsed.model).toBe('sonnet');
      expect(parsed.category).toBe('testing');
      expect(parsed.version).toBe('1.0.0');

      // Test minimal metadata
      const minimalAgent: AgentInfo = {
        metadata: {
          name: 'minimal-agent',
          description: 'Minimal agent',
        },
        content: 'Content',
        filePath: '/path/to/minimal.md',
        fileName: 'minimal.md',
      };

      const minimalResult = packager.convertToCursorFormat(minimalAgent);
      const minimalParsed = JSON.parse(minimalResult);

      expect(minimalParsed.name).toBe('minimal-agent');
      expect(minimalParsed.description).toBe('Minimal agent');
      expect(minimalParsed.model).toBeUndefined();
    });
  });

  describe('convertToCodexFormat', () => {
    it('should convert to Codex YAML format with lowercased capabilities and system instructions header', () => {
      const agent = createSampleAgent();
      const result = packager.convertToCodexFormat(agent);

      expect(result).toContain('---');
      expect(result).toContain('agent_name: test-agent');
      expect(result).toContain('description: A test agent for packaging');
      expect(result).toContain('capabilities:');
      expect(result).toContain('  - read');
      expect(result).toContain('  - write');
      expect(result).toContain('  - bash');
      expect(result).not.toContain('  - Read');
      expect(result).toContain('preferred_model: sonnet');
      expect(result).toContain('# System Instructions');
      expect(result.indexOf('# System Instructions')).toBeGreaterThan(result.indexOf('---'));
    });
  });

  describe('convertToGenericFormat', () => {
    it('should create generic markdown format with metadata as comments', () => {
      const agent = createSampleAgent();
      const result = packager.convertToGenericFormat(agent);

      expect(result).toContain('---');
      expect(result).toContain('name: test-agent');
      expect(result).toContain('description: A test agent for packaging');
      expect(result).toContain('<!--');
      expect(result).toContain('Category: testing');
      expect(result).toContain('Preferred Model: sonnet');
      expect(result).toContain('Tools: Read, Write, Bash');
      expect(result).toContain('Dependencies: helper-agent');
      expect(result).toContain('-->');
    });
  });

  describe('convertToWindsurfFormat', () => {
    it('should convert to Devin Desktop markdown format without YAML frontmatter', () => {
      const agent = createSampleAgent();
      const result = packager.convertToWindsurfFormat(agent);

      // Should NOT have YAML frontmatter
      expect(result).not.toMatch(/^---/);

      // Should have heading and description
      expect(result).toContain('### test-agent');
      expect(result).toContain('> A test agent for packaging');

      // Should have capabilities block
      expect(result).toContain('<capabilities>');
      expect(result).toContain('- Read');
      expect(result).toContain('- Write');
      expect(result).toContain('- Bash');
      expect(result).toContain('</capabilities>');

      // Should have model info
      expect(result).toContain('**Model**: sonnet');

      // Should have content
      expect(result).toContain('# Test Agent');
      expect(result).toContain('You are a test agent.');
    });

    it('should handle agents without tools, model, or description', () => {
      // Test without tools
      const agentNoTools: AgentInfo = {
        metadata: {
          name: 'minimal-agent',
          description: 'Minimal agent',
        },
        content: 'Agent content',
        filePath: '/path/to/minimal.md',
        fileName: 'minimal.md',
      };

      const resultNoTools = packager.convertToWindsurfFormat(agentNoTools);

      expect(resultNoTools).toContain('### minimal-agent');
      expect(resultNoTools).toContain('> Minimal agent');
      expect(resultNoTools).not.toContain('<capabilities>');
      expect(resultNoTools).not.toContain('**Model**:');
      expect(resultNoTools).toContain('Agent content');

      // Test without description
      const agentNoDesc: AgentInfo = {
        metadata: {
          name: 'no-desc-agent',
          description: '',
        },
        content: 'Content here',
        filePath: '/path/to/agent.md',
        fileName: 'agent.md',
      };

      const resultNoDesc = packager.convertToWindsurfFormat(agentNoDesc);

      expect(resultNoDesc).toContain('### no-desc-agent');
      expect(resultNoDesc).not.toContain('> '); // No empty description
      expect(resultNoDesc).toContain('Content here');
    });
  });

  describe('getFileExtension', () => {
    it('should return correct file extension for all platforms', () => {
      const testCases = [
        { platform: 'claude', expected: '.md' },
        { platform: 'cursor', expected: '.json' },
        { platform: 'codex', expected: '.md' },
        { platform: 'generic', expected: '.md' },
        { platform: 'devin', expected: '.md' },
        { platform: 'factory', expected: '.md' },
        { platform: 'copilot', expected: '.md' },
      ];

      for (const { platform, expected } of testCases) {
        expect(packager.getFileExtension(platform as any)).toBe(expected);
      }
    });
  });

  describe('ProviderDefinition adapter dispatch', () => {
    it('uses provider definition adapter keys for supported formats', async () => {
      const agent = createSampleAgent();

      await expect(packager.package(agent, 'factory')).resolves.toMatchObject({
        format: 'factory',
        content: expect.stringContaining('name: test-agent'),
      });
      await expect(packager.package(agent, 'devin')).resolves.toMatchObject({
        format: 'devin',
        content: expect.stringContaining('### test-agent'),
      });
    });

    it('reports unsupported provider format adapters explicitly', async () => {
      const agent = createSampleAgent();

      await expect(packager.package(agent, 'opencode')).rejects.toThrow(
        "Unknown agent format adapter 'opencode-markdown'",
      );
    });
  });

  describe('getFileName', () => {
    it('should generate correct filename for each platform', () => {
      const agent = createSampleAgent();

      expect(packager.getFileName(agent, 'claude')).toBe('test-agent.md');
      expect(packager.getFileName(agent, 'cursor')).toBe('test-agent.json');
      expect(packager.getFileName(agent, 'codex')).toBe('test-agent.md');
      expect(packager.getFileName(agent, 'generic')).toBe('test-agent.md');
      expect(packager.getFileName(agent, 'devin')).toBe('test-agent.md');
      expect(packager.getFileName(agent, 'factory')).toBe('test-agent.md');
      expect(packager.getFileName(agent, 'copilot')).toBe('test-agent.md');
    });
  });

  describe('package', () => {
    it('should package for all platforms with correct format and content', async () => {
      const agent = createSampleAgent();

      const testCases = [
        { platform: 'claude', expectedContent: 'name: test-agent', noContent: null },
        { platform: 'cursor', expectedContent: null, noContent: null, parseJson: true, jsonField: 'name', jsonValue: 'test-agent' },
        { platform: 'codex', expectedContent: 'agent_name: test-agent', noContent: null },
        { platform: 'generic', expectedContent: '<!--', noContent: null },
        { platform: 'devin', expectedContent: '### test-agent', noContent: '---' },
        { platform: 'factory', expectedContent: 'name: test-agent', noContent: null },
        { platform: 'copilot', expectedContent: '<!--', noContent: null },
      ];

      for (const { platform, expectedContent, noContent, parseJson, jsonField, jsonValue } of testCases) {
        const packaged = await packager.package(agent, platform as any);

        expect(packaged.agent).toBe(agent);
        expect(packaged.format).toBe(platform);

        if (parseJson && jsonField && jsonValue) {
          const parsed = JSON.parse(packaged.content);
          expect(parsed[jsonField]).toBe(jsonValue);
        }

        if (expectedContent) {
          expect(packaged.content).toContain(expectedContent);
        }

        if (noContent) {
          expect(packaged.content).not.toMatch(new RegExp(`^${noContent}`));
        }
      }
    });

    it('should throw on unknown platform', async () => {
      const agent = createSampleAgent();

      await expect(
        packager.package(agent, 'unknown' as any)
      ).rejects.toThrow('Unknown platform');
    });
  });

  describe('packageBatch', () => {
    it('should package multiple agents', async () => {
      const agents: AgentInfo[] = [
        createSampleAgent(),
        {
          ...createSampleAgent(),
          metadata: { ...createSampleAgent().metadata, name: 'agent-2' },
        },
        {
          ...createSampleAgent(),
          metadata: { ...createSampleAgent().metadata, name: 'agent-3' },
        },
      ];

      const packaged = await packager.packageBatch(agents, 'claude');

      expect(packaged).toHaveLength(3);
      expect(packaged.every((p) => p.format === 'claude')).toBe(true);
    });
  });

  describe('createCombinedFile', () => {
    it('should create combined AGENTS.md file with multiple agents', async () => {
      const agents: AgentInfo[] = [
        createSampleAgent(),
        {
          ...createSampleAgent(),
          metadata: { ...createSampleAgent().metadata, name: 'agent-2', description: 'Second agent' },
        },
      ];

      const combined = await packager.createCombinedFile(agents, 'claude');

      expect(combined).toContain('# Available Agents');
      expect(combined).toContain('Platform: claude');
      expect(combined).toContain('Total Agents: 2');
      expect(combined).toContain('## Table of Contents');
      expect(combined).toContain('- [test-agent]');
      expect(combined).toContain('- [agent-2]');
      expect(combined).toContain('## test-agent');
      expect(combined).toContain('## agent-2');
      expect(combined).toContain('---'); // Separator between agents
    });

    it('should handle single agent and include full content', async () => {
      const agent = createSampleAgent();
      const combined = await packager.createCombinedFile([agent], 'claude');

      expect(combined).toContain('Total Agents: 1');
      expect(combined).toContain('## test-agent');
      expect(combined).not.toContain('---\n\n## '); // No separator for single agent
      expect(combined).toContain('name: test-agent');
      expect(combined).toContain('# Test Agent');
      expect(combined).toContain('You are a test agent.');
    });
  });
});
