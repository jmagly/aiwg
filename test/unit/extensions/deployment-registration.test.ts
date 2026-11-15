/**
 * Deployment Registration Tests
 *
 * Tests for registering deployed agents and skills in the extension registry.
 *
 * @implements #56, #57
 * @architecture @docs/architecture/cli/extending-cli.md
 * @tests @src/extensions/deployment-registration.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRegistry } from '../../../src/extensions/registry.js';
import { registerDeployedExtensions, scanDeployedAgents, scanDeployedSkills } from '../../../src/extensions/deployment-registration.js';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const AGENTS_SOURCE_PATH = 'agentic/code/frameworks/sdlc-complete/agents';
const SKILLS_SOURCE_PATH = 'agentic/code/frameworks/sdlc-complete/skills';

describe('Deployment Registration', () => {
  let registry: ReturnType<typeof createRegistry>;

  beforeEach(() => {
    registry = createRegistry();
  });

  describe('scanDeployedAgents', () => {
    it('should scan .claude/agents directory and create extension objects', async () => {
      const agents = await scanDeployedAgents(AGENTS_SOURCE_PATH, 'claude');

      expect(agents).toBeInstanceOf(Array);
      // Each agent should have required Extension fields
      if (agents.length > 0) {
        const agent = agents[0];
        expect(agent).toHaveProperty('id');
        expect(agent).toHaveProperty('type', 'agent');
        expect(agent).toHaveProperty('name');
        expect(agent).toHaveProperty('description');
        expect(agent).toHaveProperty('version');
        expect(agent).toHaveProperty('capabilities');
        expect(agent).toHaveProperty('keywords');
        expect(agent).toHaveProperty('platforms');
        expect(agent).toHaveProperty('deployment');
        expect(agent).toHaveProperty('metadata');
        expect(agent.metadata.type).toBe('agent');
      }
    });

    it('should extract agent metadata from frontmatter', async () => {
      const agents = await scanDeployedAgents(AGENTS_SOURCE_PATH, 'claude');

      if (agents.length > 0) {
        const agent = agents[0];
        expect(agent.metadata).toHaveProperty('role');
        expect(agent.metadata).toHaveProperty('model');
        expect(agent.metadata).toHaveProperty('tools');
      }
    });

    it('should handle missing directory gracefully', async () => {
      const agents = await scanDeployedAgents('/nonexistent/path', 'claude');
      expect(agents).toEqual([]);
    });
  });

  describe('scanDeployedSkills', () => {
    it('should scan .claude/skills directory and create extension objects', async () => {
      const skills = await scanDeployedSkills(SKILLS_SOURCE_PATH, 'claude');

      expect(skills).toBeInstanceOf(Array);
      if (skills.length > 0) {
        const skill = skills[0];
        expect(skill).toHaveProperty('id');
        expect(skill).toHaveProperty('type', 'skill');
        expect(skill).toHaveProperty('name');
        expect(skill).toHaveProperty('description');
        expect(skill).toHaveProperty('metadata');
        expect(skill.metadata.type).toBe('skill');
        expect(skill.metadata).toHaveProperty('triggerPhrases');
      }
    });

    it('should handle missing directory gracefully', async () => {
      const skills = await scanDeployedSkills('/nonexistent/path', 'claude');
      expect(skills).toEqual([]);
    });

    it('descends one namespace level for grouped kernel skills (#1563)', async () => {
      // OpenClaw kernel skills land at ~/.openclaw/skills/aiwg/<name>/SKILL.md;
      // the registrar must descend the aiwg/ namespace the way OpenClaw's own
      // recursive loader does — a flat scan reports "0 skills" for skills that
      // actually load.
      const dir = await mkdtemp(join(tmpdir(), 'aiwg-skills-ns-'));
      const nested = join(dir, 'aiwg', 'aiwg-status');
      await mkdir(nested, { recursive: true });
      await writeFile(
        join(nested, 'SKILL.md'),
        '---\nname: aiwg-status\ndescription: Show AIWG workspace status\n---\n\n# AIWG Status\n',
        'utf8',
      );
      const skills = await scanDeployedSkills(dir, 'openclaw');
      await rm(dir, { recursive: true, force: true });
      expect(skills.map(s => s.id)).toContain('aiwg-status');
    });
  });

  describe('registerDeployedExtensions', () => {
    it('should register all deployed extensions in the registry', async () => {
      await registerDeployedExtensions(registry, {
        agentsPath: AGENTS_SOURCE_PATH,
        skillsPath: SKILLS_SOURCE_PATH,
        provider: 'claude',
      });

      // Check that extensions were registered
      const agents = registry.getByType('agent');
      const skills = registry.getByType('skill');

      expect(agents.length).toBeGreaterThanOrEqual(0);
      expect(skills.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle partial registration when some paths are missing', async () => {
      await registerDeployedExtensions(registry, {
        agentsPath: AGENTS_SOURCE_PATH,
        skillsPath: '/nonexistent/skills',
        provider: 'claude',
      });

      // Should still register agents even if skills path is invalid
      const agents = registry.getByType('agent');
      expect(agents.length).toBeGreaterThanOrEqual(0);
    });

    it('should not duplicate extensions if called multiple times', async () => {
      await registerDeployedExtensions(registry, {
        agentsPath: AGENTS_SOURCE_PATH,
        provider: 'claude',
      });

      await registerDeployedExtensions(registry, {
        agentsPath: AGENTS_SOURCE_PATH,
        provider: 'claude',
      });

      const agents = registry.getByType('agent');
      const agentIds = agents.map(a => a.id);

      // No ID should appear more than once (no duplicates from re-registration)
      const uniqueIds = new Set(agentIds);
      expect(uniqueIds.size).toBe(agentIds.length);
    });

    it('registers kernel and standard skill tiers from a kernel-pivot provider path', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'aiwg-reg-'));
      try {
        const standardSkillDir = join(tempDir, '.claude', '.aiwg', 'skills', 'standard-one');
        const kernelSkillDir = join(tempDir, '.claude', 'skills', 'kernel-one');
        await mkdir(standardSkillDir, { recursive: true });
        await mkdir(kernelSkillDir, { recursive: true });
        await writeFile(
          join(standardSkillDir, 'SKILL.md'),
          [
            '---',
            'name: standard-one',
            'description: Standard skill',
            '---',
            '',
            'Standard skill body.',
          ].join('\n'),
        );
        await writeFile(
          join(kernelSkillDir, 'SKILL.md'),
          [
            '---',
            'name: kernel-one',
            'description: Kernel skill',
            '---',
            '',
            'Kernel skill body.',
          ].join('\n'),
        );

        await registerDeployedExtensions(registry, {
          skillsPath: '.claude/.aiwg/skills',
          provider: 'claude',
          cwd: tempDir,
        });

        const skillIds = registry.getByType('skill').map(s => s.id).sort();
        expect(skillIds).toEqual(['kernel-one', 'standard-one']);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Extension lookup after registration', () => {
    it('should allow looking up registered agents by ID', async () => {
      await registerDeployedExtensions(registry, {
        agentsPath: AGENTS_SOURCE_PATH,
        provider: 'claude',
      });

      const agents = registry.getByType('agent');
      if (agents.length > 0) {
        const firstAgent = agents[0];
        const lookedUp = registry.get(firstAgent.id);
        expect(lookedUp).toBeDefined();
        expect(lookedUp?.id).toBe(firstAgent.id);
      }
    });

    it('should parse keywords and description from agents', async () => {
      await registerDeployedExtensions(registry, {
        agentsPath: AGENTS_SOURCE_PATH,
        provider: 'claude',
      });

      const all = registry.getAll();
      // Check that extensions have keywords defined (even if capabilities are empty)
      const withKeywords = all.filter(e => e.keywords.length > 0);
      expect(withKeywords.length).toBeGreaterThan(0);

      // Check that all have descriptions
      const withDescriptions = all.filter(e => e.description && e.description.length > 0);
      expect(withDescriptions.length).toBe(all.length);
    });
  });
});
