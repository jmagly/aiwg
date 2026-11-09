// Minimal provider bridge construction and ownership boundaries.
import { describe, it, expect } from 'vitest';
import { buildAgentsMd } from '../../../src/smiths/context-pipeline/index.js';
import type { ContextPipelineOptions } from '../../../src/smiths/context-pipeline/index.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditWorkspaceContext } from '../../../src/smiths/context-pipeline/workspace-audit.js';
import { stageMigrationWrites } from '../../../src/smiths/context-pipeline/workspace-migration.js';

describe('buildAgentsMd', () => {
  const baseOpts: ContextPipelineOptions = {
    provider: 'codex',
    projectPath: '/tmp/test-project',
    sections: [
      {
        type: 'agents',
        entries: [
          {
            id: 'api-designer',
            description: 'Designs API contracts',
            path: '.codex/agents/api-designer.md',
          },
        ],
      },
    ],
  };

  it('emits the minimal bootstrap with AIWG.md link', async () => {
    const { content } = await buildAgentsMd(baseOpts);
    expect(content).toContain('<!-- AIWG:provider-bootstrap:start -->');
    expect(content).not.toContain('## Framework Context');
    expect(content).toContain('[AIWG.md](./AIWG.md)');
  });

  it('requires discovery before any context read even without prompt hooks (#4036)', async () => {
    const { content } = await buildAgentsMd(baseOpts);
    expect(content).toContain('On a new task, first run discovery for the request');
    expect(content).toContain("aiwg discover --stdin <<'AIWG_REQUEST'");
    expect(content).toContain('before any other tool call or answer');
    expect(content.indexOf('aiwg discover --stdin')).toBeLessThan(content.indexOf('[WORKSPACE.md]'));
    expect(content).toContain('After discovery, read and follow [WORKSPACE.md]');
    expect(content).toContain('Then read [AIWG.md]');
  });

  it('uses the discovery-first bridge for shared-provider migration (#4036)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-shared-bootstrap-'));
    try {
      await mkdir(join(root, '.aiwg'));
      await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify({ providers: ['codex', 'hermes'] }));
      const writes = await stageMigrationWrites(root, await auditWorkspaceContext(root));
      const content = writes.get('AGENTS.md')!;
      expect(content).toContain('On a new task, first run discovery for the request');
      expect(content.indexOf('aiwg discover --stdin')).toBeLessThan(content.indexOf('[WORKSPACE.md]'));
      expect(content).toContain('AIWG rules deployed to this project are binding');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('emits the AIWG signature comment', async () => {
    const { content } = await buildAgentsMd(baseOpts);
    expect(content).toContain('<!-- aiwg-managed -->');
  });

  it('does not inline a link-index of deployed artifacts (#1239)', async () => {
    const { content, splitOccurred, spilloverContent } = await buildAgentsMd(baseOpts);
    expect(content).not.toContain('Path: `.codex/agents/api-designer.md`');
    expect(content).not.toContain('**api-designer**');
    expect(content).not.toContain('.codex/agents/api-designer.md');
    expect(splitOccurred).toBe(false);
    expect(spilloverContent).toBe('');
  });

  it('emits a minimal canonical graph bootstrap instead of duplicating quickref detail', async () => {
    const { content } = await buildAgentsMd(baseOpts);
    expect(content.indexOf('WORKSPACE.md')).toBeLessThan(content.indexOf('AIWG.md'));
    expect(content).not.toContain('## Tier 2 Capability Map');
    expect(content).not.toContain('api-designer');
  });

  it('keeps the startup adapter constant-size for a large deployed corpus', async () => {
    const huge: ContextPipelineOptions = {
      ...baseOpts,
      sections: [
        {
          type: 'agents',
          entries: Array.from({ length: 500 }, (_, i) => ({
            id: `agent-${i}`,
            description: `Agent number ${i} with some descriptive text`,
            path: `.codex/agents/agent-${i}.md`,
          })),
        },
        {
          type: 'skills',
          entries: Array.from({ length: 500 }, (_, i) => ({
            id: `skill-${i}`,
            description: `Skill number ${i} with some descriptive text`,
            path: `.codex/skills/skill-${i}/SKILL.md`,
          })),
        },
      ],
    };
    const { content } = await buildAgentsMd(huge);
    expect(content).not.toContain('agent-0');
    expect(content).not.toContain('skill-0');
    expect(content).not.toContain('agent-499');
    expect(content).not.toContain('skill-499');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(2 * 1024);
  });

  it('does not inspect or inline deployed artifact IDs', async () => {
    const opts: ContextPipelineOptions = {
      ...baseOpts,
      sections: [
        {
          type: 'agents',
          entries: [
            {
              id: 'bad`id',
              description: 'Plain description',
              path: '.codex/agents/bad-id.md',
            },
          ],
        },
      ],
    };
    const { content } = await buildAgentsMd(opts);
    expect(content).not.toContain('bad`id');
  });

  it('routes discovery through AIWG.md', async () => {
    const { content } = await buildAgentsMd(baseOpts);
    expect(content).toContain('[AIWG.md](./AIWG.md)');
    expect(content).not.toContain('## Rule:');
    expect(content).not.toContain('## Context Finalization');
  });

  it('stays well under the 30KB soft threshold', async () => {
    const huge: ContextPipelineOptions = {
      ...baseOpts,
      sections: [
        {
          type: 'agents',
          entries: Array.from({ length: 500 }, (_, i) => ({
            id: `agent-${i}`,
            description: `Agent number ${i} with some descriptive text`,
            path: `.codex/agents/agent-${i}.md`,
          })),
        },
      ],
    };
    const { content } = await buildAgentsMd(huge);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(2 * 1024);
  });

  it('routes project context to WORKSPACE.md instead of inlining it', async () => {
    const opts: ContextPipelineOptions = {
      ...baseOpts,
      projectContext: 'A short project description.',
    };
    const { content, warnings } = await buildAgentsMd(opts);
    expect(content).not.toContain('A short project description.');
    expect(warnings.some((warning) => warning.includes('WORKSPACE.md'))).toBe(true);
  });

  it('routes even legacy projectContext input to WORKSPACE.md', async () => {
    const opts: ContextPipelineOptions = {
      ...baseOpts,
      projectContext: 'Has `backticks` everywhere',
    };
    const { content, warnings } = await buildAgentsMd(opts);
    expect(content).not.toContain('## Project Context');
    expect(warnings.some((w) => w.includes('WORKSPACE.md'))).toBe(true);
  });

  it('marks generated ownership and preserves operator additions outside blocks', async () => {
    const { content } = await buildAgentsMd(baseOpts);
    expect(content).not.toContain('<!-- AIWG:agents-md:start -->');
    expect(content).toContain('Edit AGENTS.override.md for operator additions');
  });

  it('emits no warnings for a deploy with backtick-bearing artifact descriptions (#1239)', async () => {
    // Pre-#1239 the link-index ran every description through the sanitizer
    // and rejected backtick-bearing entries with a warning. The thin-pointer
    // body never sees `opts.sections`, so those warnings stop firing.
    const opts: ContextPipelineOptions = {
      ...baseOpts,
      sections: [
        {
          type: 'agents',
          entries: [
            {
              id: 'aiwg-finder',
              description: 'Runs the `aiwg discover` + `aiwg show` pipeline',
              path: '.codex/agents/aiwg-finder.md',
            },
          ],
        },
      ],
    };
    const { warnings } = await buildAgentsMd(opts);
    expect(warnings).toEqual([]);
  });
});

