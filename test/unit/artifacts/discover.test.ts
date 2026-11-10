/**
 * Capability discovery — `aiwg index discover` subcommand tests.
 *
 * Covers #1214:
 *   - Type inference for operational asset types from source paths
 *   - Trigger extraction from `## Triggers` section
 *   - Capability extraction from frontmatter description / body fallback
 *   - Scorer trigger boost + multi-token matching
 *   - End-to-end buildIndex → discoverCapability round trip
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  extractTriggers,
  extractCapability,
  buildIndex,
} from '../../../src/artifacts/index-builder.js';
import { discoverCapability } from '../../../src/artifacts/query-engine.js';
import type { ArtifactIndex } from '../../../src/artifacts/types.js';
import { getGraphIndexDir, GRAPH_CONFIGS, OPERATIONAL_DISCOVERY_TYPES } from '../../../src/artifacts/types.js';

let tmpRoot: string;
let cwd: string;

function markRuntimeRoot(root: string): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aiwg' }));
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    fs.mkdirSync(path.join(root, 'agentic/code', kind), { recursive: true });
  }
}

function writeSkill(slug: string, framework: string, body: string): string {
  markRuntimeRoot(cwd);
  const dir = path.join(cwd, 'agentic', 'code', 'frameworks', framework, 'skills', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

let previousXdgDataHome: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-discover-'));
  cwd = path.join(tmpRoot, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  // The framework graph is USER-GLOBAL. This file builds it 18 times from
  // two-artifact fixtures; unsandboxed, each one overwrites the developer's real
  // ~/.local/share/aiwg/index/framework and silently breaks `aiwg discover`
  // host-wide until the next full rebuild. Pin it here rather than per call so
  // new tests inherit the sandbox instead of having to remember it (#2544).
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(tmpRoot, 'xdg');
  // Clear any user-defined graphs leaked from earlier tests
  for (const k of Object.keys(GRAPH_CONFIGS)) {
    if (!['framework', 'project', 'codebase', 'source', 'user'].includes(k)) {
      delete GRAPH_CONFIGS[k];
    }
  }
});

afterEach(() => {
  if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgDataHome;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('extractTriggers', () => {
  it('extracts bullet-style trigger phrases under ## Triggers heading', () => {
    const body = `# Skill

Some intro.

## Triggers

- "create new project" — kicks off scaffolding
- "start fresh project"
- new project

## Other Section

Should be ignored.
- not a trigger
`;
    expect(extractTriggers(body)).toEqual([
      'create new project',
      'start fresh project',
      'new project',
    ]);
  });

  it('is applied to rules, not only skills (#2544)', () => {
    // `rule` is in OPERATIONAL_DISCOVERY_TYPES, so the indexer runs trigger
    // extraction over rule bodies. A rule's name describes the policy, not the
    // question an agent asks, so without triggers it ranks only on lexical
    // title overlap and loses to any skill whose triggers cover a token.
    expect(OPERATIONAL_DISCOVERY_TYPES).toContain('rule');
    expect(extractTriggers('# Human Authorization Rules\n\nBody.', {
      enforcement: 'high',
      triggers: ['am I allowed to do this', 'do I need permission for this'],
      // Extraction lowercases, so frontmatter casing does not matter.
    })).toEqual(['am i allowed to do this', 'do i need permission for this']);
  });

  it('returns empty array when no Triggers section exists', () => {
    expect(extractTriggers('# Just a heading\n\nNo triggers here.')).toEqual([]);
  });

  it('includes frontmatter trigger metadata without requiring a body section', () => {
    expect(extractTriggers('# Skill\n\nNo trigger section here.', {
      triggers: ['Help me start a project.', 'intake wizard'],
    })).toEqual(['help me start a project.', 'intake wizard']);
  });

  it('deduplicates frontmatter and body trigger phrases', () => {
    const body = `## Triggers

- "intake wizard"
- "start an intake"
`;
    expect(extractTriggers(body, {
      triggers: ['Intake Wizard', 'Help me start a project.'],
    })).toEqual(['intake wizard', 'help me start a project.', 'start an intake']);
  });

  it('includes compatibility aliases and deprecated names', () => {
    expect(extractTriggers('# Skill', {
      triggers: ['Ralph loop'],
      aliases: ['al', 'agent-loop'],
      deprecated_names: ['al'],
    })).toEqual(['ralph loop', 'al', 'agent-loop']);
  });

  it('handles arrow-style explanation separators', () => {
    const body = `## Triggers

- "deploy to prod" → invokes the deployment skill
- ship it → same thing
`;
    expect(extractTriggers(body)).toEqual(['deploy to prod', 'ship it']);
  });

  it('strips leading/trailing quote characters', () => {
    const body = `## Triggers

- "what can aiwg do"
- 'list aiwg commands'
`;
    expect(extractTriggers(body)).toEqual(['what can aiwg do', 'list aiwg commands']);
  });

  // #1273 — broadened regex to accept the "Natural Language Triggers" heading
  // used by orchestration skills like address-issues.
  it('accepts "## Natural Language Triggers" heading variant', () => {
    const body = `# Skill

## Natural Language Triggers

Users may say:
- "address the open issues"
- "work through the bugs"
- "fix open issues"

## Parameters
`;
    expect(extractTriggers(body)).toEqual([
      'address the open issues',
      'work through the bugs',
      'fix open issues',
    ]);
  });

  it('accepts "## Activation Phrases" heading variant', () => {
    const body = `## Activation Phrases

- "do the thing"
- "go go go"
`;
    expect(extractTriggers(body)).toEqual(['do the thing', 'go go go']);
  });

  it('accepts "## When to invoke" heading variant', () => {
    const body = `## When to invoke

- "the user asks for X"
`;
    expect(extractTriggers(body)).toEqual(['the user asks for x']);
  });
});

describe('extractCapability', () => {
  it('prefers frontmatter description', () => {
    const cap = extractCapability(
      { description: 'Generate or complete intake forms' },
      '# body\n\nbody text',
    );
    expect(cap).toBe('Generate or complete intake forms');
  });

  it('falls back to first non-heading paragraph when no description', () => {
    const cap = extractCapability(
      {},
      '# Heading\n\nThe first body paragraph describes the skill.',
    );
    expect(cap).toBe('The first body paragraph describes the skill.');
  });

  it('caps capability length at 240 chars', () => {
    const long = 'Lorem ipsum '.repeat(50);
    const cap = extractCapability({ description: long }, '');
    expect(cap!.length).toBeLessThanOrEqual(240);
  });

  it('falls back to title text when the body has only headings', () => {
    expect(extractCapability({}, '# Just headings\n\n## More headings')).toBe('Just headings');
  });
});

describe('buildIndex → type inference', () => {
  it('classifies skills, agents, commands, rules from source paths', async () => {
    // Build a synthetic framework source tree
    writeSkill(
      'demo-skill',
      'demo-framework',
      `---\nname: demo-skill\ndescription: Demo skill for type-inference test\n---\n\n## Triggers\n\n- demo trigger\n`,
    );
    const agentDir = path.join(
      cwd, 'agentic', 'code', 'frameworks', 'demo-framework', 'agents',
    );
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'demo-agent.md'),
      `---\nname: demo-agent\ndescription: Demo agent\n---\n# Demo Agent\n`,
      'utf8',
    );
    const cmdDir = path.join(
      cwd, 'agentic', 'code', 'frameworks', 'demo-framework', 'commands',
    );
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(cmdDir, 'demo-command.md'),
      `---\nname: demo-command\ndescription: Demo command\n---\n# Demo Command\n`,
      'utf8',
    );
    const ruleDir = path.join(
      cwd, 'agentic', 'code', 'frameworks', 'demo-framework', 'rules',
    );
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, 'demo-rule.md'),
      `---\ntitle: Demo rule\ndescription: A demo rule\n---\n# Demo Rule\n`,
      'utf8',
    );

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();

    const indexDir = getGraphIndexDir(cwd, 'framework');
    const metadataPath = path.join(indexDir, 'metadata.json');
    const idx: ArtifactIndex = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const byPath = new Map<string, string>();
    for (const e of Object.values(idx.entries)) {
      byPath.set(e.path, e.type);
    }

    // Type inference checks for entries that came from this test's fixtures.
    // Other entries from prior runs may exist in the shared XDG framework index,
    // but our fixtures should be classified correctly.
    const skillEntry = Object.values(idx.entries).find(e =>
      e.path.includes('demo-framework/skills/demo-skill/SKILL.md'),
    );
    expect(skillEntry?.type).toBe('skill');
    expect(skillEntry?.triggers).toContain('demo trigger');
    expect(skillEntry?.capability).toBe('Demo skill for type-inference test');

    const agentEntry = Object.values(idx.entries).find(e =>
      e.path.includes('demo-framework/agents/demo-agent.md'),
    );
    expect(agentEntry?.type).toBe('agent');

    const cmdEntry = Object.values(idx.entries).find(e =>
      e.path.includes('demo-framework/commands/demo-command.md'),
    );
    expect(cmdEntry?.type).toBe('command');

    const ruleEntry = Object.values(idx.entries).find(e =>
      e.path.includes('demo-framework/rules/demo-rule.md'),
    );
    expect(ruleEntry?.type).toBe('rule');
  });
});

describe('discoverCapability — JSON output', () => {
  it('keeps canonical skill aliases discoverable after a rename', async () => {
    writeSkill(
      'ralph',
      'agent-loop',
      `---
name: ralph
description: Execute an iterative task loop until completion
aliases: [al, agent-loop]
deprecated_names: [al]
---

# Agent Loop
`,
    );

    const setupSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setupErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    setupSpy.mockRestore();
    setupErrSpy.mockRestore();

    for (const phrase of ['agent-loop', 'al']) {
      const captured: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
        captured.push(args.join(' ')),
      );
      await discoverCapability(cwd, {
        phrase,
        graph: 'framework',
        json: true,
        backend: 'local',
        limit: 3,
      });
      logSpy.mockRestore();

      const parsed = JSON.parse(captured.join('\n'));
      expect(parsed.results[0]?.path, phrase).toContain('/ralph/SKILL.md');
      expect(parsed.results[0]?.ranking.matches, phrase).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'trigger',
            match: 'exact',
            value: phrase,
          }),
        ]),
      );
    }
  });

  it('does not match short one-word aliases inside longer words', async () => {
    writeSkill(
      'ralph',
      'agent-loop',
      `---
name: ralph
description: Execute an iterative task loop until completion
aliases: [al, agent-loop]
deprecated_names: [al]
---

# Agent Loop
`,
    );
    writeSkill(
      'steward',
      'aiwg-utils',
      `---
name: steward
description: Diagnose and repair stale AIWG setup and provider files
triggers:
  - "AIWG setup is stale or broken"
  - "steward repair AIWG setup"
---

# Steward
`,
    );

    const setupSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setupErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    setupSpy.mockRestore();
    setupErrSpy.mockRestore();

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
      captured.push(args.join(' ')),
    );
    await discoverCapability(cwd, {
      phrase: 'AIWG setup is stale or broken',
      graph: 'framework',
      json: true,
      backend: 'local',
      limit: 3,
    });
    logSpy.mockRestore();

    const parsed = JSON.parse(captured.join('\n'));
    expect(parsed.results[0]?.path).toContain('/steward/SKILL.md');
    expect(parsed.results[0]?.ranking.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'trigger',
          match: 'exact',
          value: 'aiwg setup is stale or broken',
        }),
      ]),
    );
    expect(
      parsed.results.some((result: { path: string; ranking: { matches: { value?: string }[] } }) =>
        result.path.includes('/ralph/SKILL.md') &&
        result.ranking.matches.some((match) => match.value === 'al'),
      ),
    ).toBe(false);
  });

  it('emits a stable schema with path/type/score/triggers/capability', async () => {
    writeSkill(
      'skill-create-intake',
      'fx',
      `---\nname: skill-create-intake\ndescription: Create new intake forms with the wizard\n---\n\n## Triggers\n\n- "create intake"\n- "new intake form"\n`,
    );

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
      captured.push(args.join(' ')),
    );

    await discoverCapability(cwd, {
      phrase: 'create intake',
      graph: 'framework',
      json: true, backend: 'local',
      limit: 3,
    });

    logSpy.mockRestore();

    const json = captured.join('\n');
    // Should contain a JSON object with results array
    const parsed = JSON.parse(json);
    expect(parsed.query.phrase).toBe('create intake');
    expect(Array.isArray(parsed.results)).toBe(true);
    // The top result should reference our seeded skill
    if (parsed.results.length > 0) {
      const top = parsed.results[0];
      expect(top).toHaveProperty('path');
      expect(top).toHaveProperty('score');
      expect(top).toHaveProperty('type');
      expect(top).toHaveProperty('triggers');
      expect(top).toHaveProperty('capability');
      expect(top).toHaveProperty('ranking');
      expect(top.ranking).toMatchObject({
        lexical_score: expect.any(Number),
        final_score: expect.any(Number),
        matches: expect.any(Array),
        tie_breakers: {
          scope: expect.any(String),
          scope_rank: expect.any(Number),
        },
      });
      expect(top.ranking.matches).toEqual(expect.arrayContaining([
        expect.objectContaining({
          field: 'trigger',
          match: 'exact',
          value: 'create intake',
          query_token_coverage: 1,
        }),
      ]));
      expect(parsed.diagnostics).toMatchObject({
        content_tokens: ['create', 'intake'],
        facet_activations: expect.any(Array),
        score_tie_break_order: ['score', 'scope', 'type', 'name', 'path'],
      });
    }
  });

  // #1561 — verbose full-sentence queries diluted the token hit ratio below
  // the strict ceil(n/2) overlap gate and dead-ended to zero results, training
  // agents to conclude "no skill exists". The relaxed-overlap fallback re-scores
  // on a single meaningful hit so wordy queries still surface ranked candidates.
  it('falls back to relaxed overlap for verbose queries instead of dead-ending (#1561)', async () => {
    writeSkill(
      'intake-wizard',
      'fx',
      `---\nname: intake-wizard\ndescription: Generate or complete intake forms interactively\n---\n\n## Triggers\n\n- "intake wizard"\n- "create intake"\n`,
    );

    const setupSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setupErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    setupSpy.mockRestore();
    setupErrSpy.mockRestore();

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
      captured.push(args.join(' ')),
    );
    // 4 content tokens after #1581 stopword stripping (intake, paperwork,
    // submission, registration); only `intake` carries signal — 1 hit, below
    // the strict ceil(4/2)=2 gate. Without the relaxed fallback this dead-ends.
    await discoverCapability(cwd, {
      phrase: 'intake paperwork submission registration',
      graph: 'framework',
      json: true, backend: 'local',
      limit: 3,
    });
    logSpy.mockRestore();

    const parsed = JSON.parse(captured.join('\n'));
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.relaxed_overlap).toBe(true);
    expect(parsed.results[0].path).toContain('intake-wizard');
  });

  // #1581 — natural-language / full-sentence queries used to score near-zero:
  // grammatical filler + AIWG meta-nouns ('find', 'a', 'skill', 'that',
  // 'handles') inflate the token count so the strict ceil(n/2) overlap gate
  // exceeds what the relevant short-match artifact can clear, and an unrelated
  // artifact with an incidental generic-word hit surfaces instead. Expanding
  // SCORE_STOPWORDS collapses the query to its content tokens so the full
  // sentence matches as strongly as the keyword phrase — in the strict pass,
  // with no relaxed fallback.
  it('matches a full-sentence query as strongly as its keyword phrase (#1581)', async () => {
    writeSkill(
      'intake-wizard',
      'fx',
      `---\nname: intake-wizard\ndescription: Generate or complete intake forms interactively\n---\n\n## Triggers\n\n- "intake wizard"\n- "create intake"\n`,
    );

    const setupSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setupErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    setupSpy.mockRestore();
    setupErrSpy.mockRestore();

    const run = async (phrase: string) => {
      const captured: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
        captured.push(args.join(' ')),
      );
      await discoverCapability(cwd, { phrase, graph: 'framework', json: true, backend: 'local', limit: 3 });
      logSpy.mockRestore();
      return JSON.parse(captured.join('\n'));
    };

    const sentence = await run('Find an AIWG skill that handles intake forms');
    const keyword = await run('intake forms');

    // Full sentence surfaces the same top artifact as the keyword phrase…
    expect(sentence.results[0].path).toContain('intake-wizard');
    expect(keyword.results[0].path).toContain('intake-wizard');
    // …via the strict pass — no relaxed-overlap fallback needed.
    expect(sentence.relaxed_overlap).toBeFalsy();
  });

  // #1581 follow-up — a query that reduces to exactly ONE content token after
  // stopword stripping ("intake skill" / "find an intake skill" → ["intake"])
  // must still match. The field substring match uses the stripped content
  // phrase, not the raw multi-word text (which contains stopwords and matches
  // nothing) — otherwise useMultiToken=false dead-ends single-content-token
  // queries.
  it('matches a query that reduces to a single content token (#1581)', async () => {
    writeSkill(
      'intake-wizard',
      'fx',
      `---\nname: intake-wizard\ndescription: Generate or complete intake forms interactively\n---\n\n## Triggers\n\n- "intake wizard"\n`,
    );
    const setupSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setupErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    setupSpy.mockRestore();
    setupErrSpy.mockRestore();

    for (const phrase of ['intake skill', 'find an intake skill']) {
      const captured: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
        captured.push(args.join(' ')),
      );
      await discoverCapability(cwd, { phrase, graph: 'framework', json: true, backend: 'local', limit: 3 });
      logSpy.mockRestore();
      const parsed = JSON.parse(captured.join('\n'));
      expect(parsed.results.length, `"${phrase}" should not dead-end`).toBeGreaterThan(0);
      expect(parsed.results[0].path).toContain('intake-wizard');
    }
  });

  it('does not dilute a relevant capability match with unmatched query terms (#154)', async () => {
    writeSkill(
      'product-designer',
      'design',
      `---\nname: product-designer\ndescription: Crafts user experience flows, interface designs, and interaction specs that align with product objectives\n---\n`,
    );
    writeSkill(
      'generic-reviewer',
      'design',
      `---\nname: generic-reviewer\ndescription: Reviews existing project screens\n---\n`,
    );

    const setupSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setupErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    setupSpy.mockRestore();
    setupErrSpy.mockRestore();

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
      captured.push(args.join(' ')),
    );
    await discoverCapability(cwd, {
      phrase: 'design a user interface, information architecture, UX review of an existing screen',
      graph: 'framework',
      json: true,
      backend: 'local',
      limit: 3,
    });
    logSpy.mockRestore();

    const parsed = JSON.parse(captured.join('\n'));
    const productDesigner = parsed.results.find((result: { path: string }) =>
      result.path.includes('/product-designer/SKILL.md'));
    expect(productDesigner).toBeDefined();
    expect(productDesigner.ranking.lexical_score).toBeGreaterThanOrEqual(0.2);
  });

  it('matches short acronyms on token boundaries rather than inside words (#154)', async () => {
    writeSkill(
      'linux-forensics',
      'forensics',
      `---\nname: linux-forensics\ndescription: Investigate Linux hosts and filesystems\n---\n`,
    );
    writeSkill(
      'native-ux-tools',
      'design',
      `---\nname: native-ux-tools\ndescription: Use native UX tools for interface design\n---\n`,
    );

    const setupSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setupErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    setupSpy.mockRestore();
    setupErrSpy.mockRestore();

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
      captured.push(args.join(' ')),
    );
    await discoverCapability(cwd, {
      phrase: 'UX',
      graph: 'framework',
      json: true,
      backend: 'local',
      limit: 5,
    });
    logSpy.mockRestore();

    const parsed = JSON.parse(captured.join('\n'));
    expect(parsed.results[0]?.path).toContain('/native-ux-tools/SKILL.md');
    expect(parsed.results.some((result: { path: string }) =>
      result.path.includes('/linux-forensics/SKILL.md'))).toBe(false);
  });

  // #1230 — kernel-marked skills used to short-circuit path anchoring,
  // emitting the stored relative path (`agentic/code/.../SKILL.md`).
  // `aiwg show` then resolved against cwd → ENOENT from any non-AIWG
  // workspace. Both kernel and non-kernel framework entries must now
  // anchor to AIWG_ROOT so the path is reachable regardless of cwd.
  it('emits absolute paths for kernel-marked skills (#1230)', async () => {
    // Pin AIWG_ROOT to the test's tmp tree so discover anchors against it
    // instead of the host environment's real AIWG_ROOT.
    const prevAiwgRoot = process.env.AIWG_ROOT;
    process.env.AIWG_ROOT = cwd;
    try {

    writeSkill(
      'kernel-quickref',
      'aiwg-utils',
      `---\nname: kernel-quickref\nkernel: true\ndescription: Always-loaded kernel quickref\n---\n\n## Triggers\n\n- "kernel quickref"\n`,
    );
    writeSkill(
      'normal-skill',
      'aiwg-utils',
      `---\nname: normal-skill\ndescription: A non-kernel skill\n---\n\n## Triggers\n\n- "normal skill"\n`,
    );

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
      captured.push(args.join(' ')),
    );

    await discoverCapability(cwd, {
      phrase: 'kernel quickref',
      graph: 'framework',
      json: true, backend: 'local',
      limit: 5,
    });

    logSpy.mockRestore();

    const parsed = JSON.parse(captured.join('\n'));
    const kernelHit = parsed.results.find((r: { kernel: boolean }) => r.kernel === true);
    expect(kernelHit, 'kernel-marked skill must appear in discover results').toBeDefined();
    // The fix: kernel paths must be absolute, anchored to aiwg_root.
    // Before #1230 they came back as `agentic/code/.../SKILL.md` (relative)
    // and broke aiwg show from any cwd != AIWG_ROOT.
    expect(path.isAbsolute(kernelHit.path)).toBe(true);
    // Path must end at the source SKILL.md under agentic/code/, regardless
    // of /tmp ↔ /private/tmp symlink games on the host.
    expect(kernelHit.path).toMatch(
      /agentic\/code\/frameworks\/aiwg-utils\/skills\/kernel-quickref\/SKILL\.md$/,
    );
    // And the resolved path must actually exist on disk — this is the
    // contract aiwg show depends on.
    expect(fs.existsSync(kernelHit.path)).toBe(true);
    } finally {
      if (prevAiwgRoot === undefined) delete process.env.AIWG_ROOT;
      else process.env.AIWG_ROOT = prevAiwgRoot;
    }
  });

  // #1233 — exact-name queries against kernel skills used to score ~0.10
  // because the title was derived from the Markdown heading ("AIWG
  // Doctor") which no longer contained the hyphenated slug. The scorer
  // now floors exact-name match (case- and separator-insensitive) so
  // the literal slug, the spaced form, and the underscore form all
  // return the artifact at top-1.
  it('floors exact-name queries to score 1.0 for kernel skills (#1233)', async () => {
    const prevAiwgRoot = process.env.AIWG_ROOT;
    process.env.AIWG_ROOT = cwd;
    try {

    // Seed a kernel skill whose Markdown heading drops the hyphen the
    // user types — exactly the failure mode #1233 documents.
    writeSkill(
      'aiwg-doctor',
      'aiwg-utils',
      `---\nname: aiwg-doctor\nkernel: true\ndescription: Run a comprehensive health check\n---\n\n# AIWG Doctor\n\nDiagnostics.\n`,
    );
    // And a non-kernel skill whose title contains the same words so we
    // confirm the floor (not the title-substring path) is what's lifting
    // the kernel skill to 1.0.
    writeSkill(
      'doctor-helper',
      'aiwg-utils',
      `---\nname: doctor-helper\ndescription: Helps the AIWG doctor\n---\n\n# Doctor Helper\n`,
    );

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();

    // Three forms of the same query — slug, spaced, underscored — all
    // must return the kernel skill at top-1 with score 1.
    for (const phrase of ['aiwg-doctor', 'aiwg doctor', 'aiwg_doctor']) {
      const captured: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
        captured.push(args.join(' ')),
      );
      await discoverCapability(cwd, {
        phrase,
        graph: 'framework',
        json: true, backend: 'local',
        limit: 3,
      });
      logSpy.mockRestore();

      const parsed = JSON.parse(captured.join('\n'));
      expect(parsed.results.length, `phrase=${phrase} returned no results`).toBeGreaterThan(0);
      const top = parsed.results[0];
      expect(top.path, `phrase=${phrase} top result`).toMatch(/aiwg-doctor\/SKILL\.md$/);
      expect(top.score, `phrase=${phrase} top score`).toBe(1);
      expect(top.kernel).toBe(true);
    }
    } finally {
      if (prevAiwgRoot === undefined) delete process.env.AIWG_ROOT;
      else process.env.AIWG_ROOT = prevAiwgRoot;
    }
  });

  it('matches one-edit canonical skill-name typos', async () => {
    const prevAiwgRoot = process.env.AIWG_ROOT;
    process.env.AIWG_ROOT = cwd;
    try {
      writeSkill(
        'sdlc-accelerate',
        'sdlc-complete',
        `---\nname: sdlc-accelerate\ndescription: Accelerate SDLC delivery with recommended workflows\n---\n\n# SDLC Accelerate\n`,
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();

      const captured: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
        captured.push(args.join(' ')),
      );
      await discoverCapability(cwd, {
        phrase: 'sdlc-acclerate',
        graph: 'framework',
        json: true, backend: 'local',
        limit: 3,
      });
      logSpy.mockRestore();

      const parsed = JSON.parse(captured.join('\n'));
      expect(parsed.results.length).toBeGreaterThan(0);
      expect(parsed.results[0].path).toMatch(/sdlc-accelerate\/SKILL\.md$/);
      expect(parsed.results[0].score).toBeGreaterThanOrEqual(0.95);
    } finally {
      if (prevAiwgRoot === undefined) delete process.env.AIWG_ROOT;
      else process.env.AIWG_ROOT = prevAiwgRoot;
    }
  });
});

describe('discoverCapability — exclusive capability surface (#1545)', () => {
  it('default (NO --graph) sources the framework capability graph', async () => {
    writeSkill(
      'skill-deploy-prod',
      'fx',
      `---\nname: skill-deploy-prod\ndescription: Deploy the app to production with rollback\n---\n\n## Triggers\n\n- "deploy to production"\n`,
    );
    // Build the framework (capability) graph, then discover with NO --graph:
    // the default path must source `framework` (the #1545 fix). The transparent
    // auto-build-when-missing variant is verified end-to-end at the CLI level.
    const buildSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const buildErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    buildSpy.mockRestore();
    buildErrSpy.mockRestore();

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => captured.push(a.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await discoverCapability(cwd, { phrase: 'deploy to production', json: true, backend: 'local', limit: 3 });
    logSpy.mockRestore();
    errSpy.mockRestore();

    const parsed = JSON.parse(captured.join('\n'));
    expect(parsed.results.length, 'discover should find the capability without --graph').toBeGreaterThan(0);
    expect(parsed.results.some((r: { path: string }) => r.path.endsWith('skill-deploy-prod/SKILL.md'))).toBe(true);
  });

  it('does not surface codebase (source-code) entries in capability results', async () => {
    writeSkill('skill-x', 'fx', `---\nname: skill-x\ndescription: deploy helper capability\n---\n`);
    // A codebase-graph file — discover must NOT source the codebase graph.
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'deploy.ts'), 'export function deployToProduction() {}\n');

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => captured.push(a.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await discoverCapability(cwd, { phrase: 'deploy', json: true, backend: 'local', limit: 10 });
    logSpy.mockRestore();
    errSpy.mockRestore();

    const parsed = JSON.parse(captured.join('\n'));
    expect(parsed.results.every((r: { path: string }) => !r.path.endsWith('.ts'))).toBe(true);
  });
});

describe('discoverCapability — Flow documents surface in default discover (#1540)', () => {
  it('a YAML Flow ranks alongside skills in a bare discover (no --type)', async () => {
    // A declarative Flow doc under the framework tree — parseFlowDoc must
    // classify it `type: flow`, and `flow` must be in DEFAULT_DISCOVER_TYPES
    // so it surfaces without an explicit `--type flow` filter (#1540).
    markRuntimeRoot(cwd);
    const flowDir = path.join(cwd, 'agentic', 'code', 'frameworks', 'fx', 'flows');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, 'flow-ship-it.playbook.yaml'),
      [
        'apiVersion: flow.aiwg.io/v1',
        'kind: FlowPlaybook',
        'metadata:',
        '  name: flow-ship-it',
        '  labels: { domain: release }',
        'spec:',
        '  description: Ship the release through the gate sequence to production',
        '  inventory: ctx',
        '  targets: { groups: [project] }',
        '  steps:',
        '    - id: gate',
        '      capability: ship-gate',
        '',
      ].join('\n'),
      'utf8',
    );

    const buildSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const buildErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    buildSpy.mockRestore();
    buildErrSpy.mockRestore();

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => captured.push(a.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // No typeFilter → exercises DEFAULT_DISCOVER_TYPES (which now includes `flow`).
    await discoverCapability(cwd, { phrase: 'ship release to production', json: true, backend: 'local', limit: 5 });
    logSpy.mockRestore();
    errSpy.mockRestore();

    const parsed = JSON.parse(captured.join('\n'));
    expect(parsed.results.length, 'discover should surface the Flow without --type').toBeGreaterThan(0);
    const flowHit = parsed.results.find((r: { path: string; type: string }) =>
      r.path.endsWith('flow-ship-it.playbook.yaml'),
    );
    expect(flowHit, 'Flow doc should appear in default discover results').toBeTruthy();
    expect(flowHit.type).toBe('flow');
  });
});

describe('discoverCapability — operational assets beyond skills/rules (#1792)', () => {
  it('surfaces behaviors and templates in broad default discovery and focused filters', async () => {
    const prevXdg = process.env.XDG_DATA_HOME;
    const prevRoot = process.env.AIWG_ROOT;
    process.env.XDG_DATA_HOME = path.join(tmpRoot, 'xdg-operational-assets');
    process.env.AIWG_ROOT = cwd;
    try {
      const behaviorDir = path.join(
        cwd,
        'agentic',
        'code',
        'addons',
        'fleet',
        'behaviors',
        'quiet-bot',
      );
      fs.mkdirSync(behaviorDir, { recursive: true });
      fs.writeFileSync(
        path.join(behaviorDir, 'BEHAVIOR.md'),
        [
          '---',
          'name: quiet-bot',
          'title: Quiet Bot',
          'description: Mention-only group chat behavior for budget-sensitive bot fleets.',
          '---',
          '# Quiet Bot',
          '',
          'Respond only when mentioned in shared bot channels.',
          '',
        ].join('\n'),
        'utf8',
      );

      const templateDir = path.join(
        cwd,
        'agentic',
        'code',
        'frameworks',
        'sdlc-complete',
        'templates',
        'codex',
      );
      fs.mkdirSync(templateDir, { recursive: true });
      fs.writeFileSync(
        path.join(templateDir, 'config.toml.aiwg-template'),
        [
          '# Codex Config Template',
          '',
          'codex config toml provider template for agent runtime setup.',
          '',
        ].join('\n'),
        'utf8',
      );

      const buildSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const buildErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
      buildSpy.mockRestore();
      buildErrSpy.mockRestore();

      async function runDiscover(phrase: string, typeFilter?: string[]) {
        const captured: string[] = [];
        const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => captured.push(a.join(' ')));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await discoverCapability(cwd, {
          phrase,
          typeFilter,
          graph: 'framework',
          json: true,
          backend: 'local',
          limit: 10,
        });
        logSpy.mockRestore();
        errSpy.mockRestore();
        return JSON.parse(captured.join('\n'));
      }

      const broadBehavior = await runDiscover('quiet bot mention only');
      const behaviorHit = broadBehavior.results.find((r: { type: string; name?: string; path: string }) =>
        r.type === 'behavior' && r.name === 'quiet-bot' && r.path.endsWith('quiet-bot/BEHAVIOR.md'),
      );
      expect(behaviorHit, 'behavior should be in default broad discover').toBeTruthy();

      const broadTemplate = await runDiscover('codex config toml provider');
      const templateHit = broadTemplate.results.find((r: { type: string; name?: string; path: string }) =>
        r.type === 'template' && r.name === 'config.toml' && r.path.endsWith('config.toml.aiwg-template'),
      );
      expect(templateHit, 'template should be in default broad discover').toBeTruthy();

      const focusedBehavior = await runDiscover('quiet bot', ['behavior']);
      expect(focusedBehavior.results[0].type).toBe('behavior');

      const focusedTemplate = await runDiscover('config toml', ['template']);
      expect(focusedTemplate.results[0].type).toBe('template');
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
      if (prevRoot === undefined) delete process.env.AIWG_ROOT;
      else process.env.AIWG_ROOT = prevRoot;
    }
  });
});

describe('discoverCapability — deployed commands are discoverable (#1541)', () => {
  // #1541: `aiwg discover "address-issues"` returned nothing in a user opencode
  // project even though the command source exists in the framework graph. Two
  // root causes: (a) discover must source the framework graph (#1545), and
  // (b) when the framework index is absent, discover must auto-build it from the
  // AIWG install root ($AIWG_ROOT) — a user project's cwd has no agentic/code,
  // so the cwd-only auto-build never fired.

  function writeFrameworkCommand(root: string, slug: string, desc: string): void {
    markRuntimeRoot(root);
    const dir = path.join(root, 'agentic', 'code', 'frameworks', 'fx', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.md`), `---\ndescription: ${desc}\n---\n\n# ${slug}\n`, 'utf8');
  }

  it('a command in the framework graph is found by name + via --type command', () => {
    const prevXdg = process.env.XDG_DATA_HOME;
    const prevRoot = process.env.AIWG_ROOT;
    process.env.XDG_DATA_HOME = path.join(tmpRoot, 'xdg-a'); // sandbox the shared framework index
    process.env.AIWG_ROOT = cwd;
    try {
      writeFrameworkCommand(cwd, 'addr-issues', 'Address selected issues in bounded slices');
      const b = vi.spyOn(console, 'log').mockImplementation(() => {});
      const be = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Build directly here (force) so the assertion is deterministic.
      // The auto-build path is exercised by the next test.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return import('../../../src/artifacts/index-builder.js').then(async ({ buildIndex }) => {
        await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
        b.mockRestore(); be.mockRestore();
        const captured: string[] = [];
        const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => captured.push(a.join(' ')));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await discoverCapability(cwd, { phrase: 'addr-issues', typeFilter: ['command'], json: true, backend: 'local', limit: 5 });
        logSpy.mockRestore(); errSpy.mockRestore();
        const parsed = JSON.parse(captured.join('\n'));
        const hit = parsed.results.find((r: { path: string; type: string }) => r.path.endsWith('commands/addr-issues.md'));
        expect(hit, 'command should be discoverable by name').toBeTruthy();
        expect(hit.type).toBe('command');
      });
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
      if (prevRoot === undefined) delete process.env.AIWG_ROOT; else process.env.AIWG_ROOT = prevRoot;
    }
  });

  it('auto-builds the framework index from $AIWG_ROOT when cwd has no agentic/code (user-project case)', async () => {
    const prevXdg = process.env.XDG_DATA_HOME;
    const prevRoot = process.env.AIWG_ROOT;
    // Fresh XDG so NO framework index exists yet — forces the auto-build path.
    process.env.XDG_DATA_HOME = path.join(tmpRoot, 'xdg-b');
    // AIWG install root (has agentic/code) is SEPARATE from the user project cwd.
    const installRoot = path.join(tmpRoot, 'aiwg-install');
    fs.mkdirSync(installRoot, { recursive: true });
    writeFrameworkCommand(installRoot, 'addr-issues', 'Address selected issues in bounded slices');
    process.env.AIWG_ROOT = installRoot;
    // User project: a cwd with NO agentic/code (so the cwd-only auto-build can't fire).
    const userProject = path.join(tmpRoot, 'user-project');
    fs.mkdirSync(userProject, { recursive: true });
    try {
      const captured: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => captured.push(a.join(' ')));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await discoverCapability(userProject, { phrase: 'addr-issues', typeFilter: ['command'], json: true, backend: 'local', limit: 5 });
      logSpy.mockRestore(); errSpy.mockRestore();
      const parsed = JSON.parse(captured.join('\n'));
      const hit = parsed.results?.find((r: { path: string }) => r.path.endsWith('commands/addr-issues.md'));
      expect(hit, 'discover should auto-build the framework index from $AIWG_ROOT and find the command').toBeTruthy();
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
      if (prevRoot === undefined) delete process.env.AIWG_ROOT; else process.env.AIWG_ROOT = prevRoot;
    }
  });
});

// #1598 — native release-engineering queries (cargo / pkgid / deb / rpm / GHCR /
// release artifacts) used to route to package-all-plugins because its
// description framed it as a generic "release-prep operation" and its triggers
// were release-themed. The skill is now plugin-scoped, so native-release queries
// fall through to flow-release while plugin-packaging queries still find it.
describe('discover — native-release vs plugin packaging routing (#1598)', () => {
  // Mirrors the real (fixed) package-all-plugins frontmatter description: purely
  // plugin-positive, no native/release/build/artifacts vocabulary (those tokens
  // are scored, so putting them here — even as a negation — would backfire and
  // re-match native-release queries).
  const PACKAGE_ALL_PLUGINS_DESC =
    'Batch package every AIWG/Codex plugin in the workspace into distributable plugin archives — runs package-plugin for all plugins at once';

  const seed = async () => {
    writeSkill(
      'package-all-plugins',
      'aiwg-utils',
      `---\nname: package-all-plugins\ndescription: ${PACKAGE_ALL_PLUGINS_DESC}\n---\n\n## Triggers\n\n- "package all the plugins"\n- "build all plugin archives"\n- "bundle all plugins"\n- "batch package the plugins"\n- "publish all plugins"\n`,
    );
    writeSkill(
      'flow-release',
      'sdlc-complete',
      `---\nname: flow-release\ndescription: Config-driven release orchestration — reads .aiwg/release.config plus optional .aiwg/releases/<plan-id> sidecars and walks the selected release plan's gates\n---\n\n## Triggers\n\n- "run the release"\n- "release prep"\n- "cut a release"\n`,
    );
    const s = vi.spyOn(console, 'log').mockImplementation(() => {});
    const e = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    s.mockRestore();
    e.mockRestore();
  };

  const run = async (phrase: string) => {
    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
      captured.push(args.join(' ')),
    );
    await discoverCapability(cwd, { phrase, graph: 'framework', json: true, backend: 'local', limit: 5 });
    logSpy.mockRestore();
    return JSON.parse(captured.join('\n'));
  };

  const rankOf = (parsed: { results: { path: string }[] }, slug: string) =>
    parsed.results.findIndex(r => r.path.includes(`/${slug}/SKILL.md`));

  it('does NOT rank package-all-plugins top for native release-package queries', async () => {
    await seed();
    const parsed = await run(
      'release prep validation cargo pkgid build package artifacts version 2026.6.2',
    );
    // The top result must not be the plugin-packaging skill for a native query.
    expect(parsed.results[0]?.path ?? '').not.toContain('package-all-plugins');
    // flow-release should be present and rank above package-all-plugins (if the
    // latter surfaces at all from the incidental "package"/"build" token hits).
    const rel = rankOf(parsed, 'flow-release');
    const pap = rankOf(parsed, 'package-all-plugins');
    expect(rel, 'flow-release should surface for native release queries').toBeGreaterThanOrEqual(0);
    if (pap >= 0) {
      expect(rel, 'flow-release must outrank package-all-plugins').toBeLessThan(pap);
    }
  });

  it('still ranks package-all-plugins top for plugin-packaging queries', async () => {
    await seed();
    const parsed = await run('package all the plugins for release');
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0].path).toContain('package-all-plugins');
  });

  it('the real package-all-plugins skill stays plugin-scoped (no generic release-prep framing)', () => {
    const real = path.join(
      process.cwd(),
      'agentic/code/addons/aiwg-utils/skills/package-all-plugins/SKILL.md',
    );
    if (!fs.existsSync(real)) return; // tolerate alternate checkout layouts
    const src = fs.readFileSync(real, 'utf8');
    const fm = src.split('---')[1] ?? '';
    const fmLower = fm.toLowerCase();
    expect(fmLower, 'frontmatter should be plugin-scoped').toContain('plugin');
    // The generic "release-prep" framing was the #1598 root cause — keep it out
    // of the scored frontmatter (clarifying prose may stay in the body).
    expect(fmLower, 'frontmatter must not carry generic release-prep framing').not.toContain(
      'release-prep',
    );
  });

  // #1599 — there was no focused capability for post-tag release publication
  // proof; native-release verification queries dead-ended on broad skills. The
  // new release-publication-verify skill must surface for them.
  it('release-publication-verify is the top hit for post-tag release-proof queries (#1599)', async () => {
    const VERIFY_DESC =
      'Post-tag release publication verifier — given a tag, verify the published release surfaces (Gitea/GitHub release assets, SHA256SUMS and native package checksums, GHCR container images, installer dry-run from the real release URL) and emit issue-comment-ready evidence, distinguishing missing proof from failed proof, before closing release-completion issues';
    writeSkill(
      'release-publication-verify',
      'sdlc-complete',
      `---\nname: release-publication-verify\ndescription: ${VERIFY_DESC}\n---\n\n## Triggers\n\n- "verify the release publication"\n- "post-tag release asset verifier"\n- "check GHCR images and release assets for a tag"\n`,
    );
    writeSkill(
      'package-all-plugins',
      'aiwg-utils',
      `---\nname: package-all-plugins\ndescription: Batch package every AIWG/Codex plugin in the workspace into distributable plugin archives — runs package-plugin for all plugins at once\n---\n\n## Triggers\n\n- "package all the plugins"\n`,
    );
    const s = vi.spyOn(console, 'log').mockImplementation(() => {});
    const e = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
    s.mockRestore();
    e.mockRestore();

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) =>
      captured.push(args.join(' ')),
    );
    await discoverCapability(cwd, {
      phrase: 'post tag release asset verifier GHCR packages installer release assets',
      graph: 'framework',
      json: true, backend: 'local',
      limit: 5,
    });
    logSpy.mockRestore();
    const parsed = JSON.parse(captured.join('\n'));
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0].path).toContain('release-publication-verify');
  });
});

describe('experimental discovery shadow integration', () => {
  it('passes only retrieved candidates to the observer and preserves emitted ranking on failure', async () => {
    writeSkill('intake-first', 'fx', '---\nname: intake-first\ndescription: intake forms\n---\n');
    writeSkill('intake-second', 'fx', '---\nname: intake-second\ndescription: intake forms\n---\n');
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await buildIndex(cwd, { graph: 'framework', force: true, explicit: true });
      const options = { phrase: 'intake forms', graph: 'framework' as const, json: true, backend: 'local' as const, limit: 3 };
      logs.length = 0;
      await discoverCapability(cwd, options);
      const baseline = JSON.parse(logs.join('\n'));
      const observer = { observe: vi.fn(async () => { throw new Error('offline observer failure'); }), disable: vi.fn() };
      logs.length = 0;
      await discoverCapability(cwd, { ...options, shadowRoute: observer as unknown as import('../../../src/artifacts/discovery-shadow.js').DiscoveryShadowRoute });
      const shadow = JSON.parse(logs.join('\n'));
      expect(shadow.results).toEqual(baseline.results);
      expect(observer.observe).toHaveBeenCalledWith('intake forms', baseline.results.map((r: { id: string; name: string; type: string; capability: string }) => expect.objectContaining({ id: r.id, name: r.name, type: r.type, capability: r.capability })));
      expect(observer.disable).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); err.mockRestore(); }
  });
});
