import { existsSync } from 'fs';
import { spawnSync } from 'node:child_process';
import { transformAgent } from '../../../tools/agents/providers/codex.mjs';
import { addManagedMarker } from '../../../tools/agents/providers/base.mjs';
import { createPackagedCodexRenderer } from '../../../tools/agents/providers/packaged-codex-agents.mjs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_DEF_CEILING_BYTES,
  AGENT_DEF_SIZE_ALLOWLIST,
  PACKAGED_CODEX_AGENT_TARGET_BYTES,
  formatAgentDefSizeReport,
  main,
  scanDeployedAgentDefSizes,
  scanPackagedCodexAgentDefSizes,
} from '../../../tools/lint/agent-def-sizes.mjs';

async function writeAgent(root: string, relDir: string, name: string, bytes: number) {
  const dir = join(root, relDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), 'x'.repeat(bytes));
}

const temporaryRoots = new Set<string>();

async function makeTemporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-agent-size-'));
  temporaryRoots.add(root);
  return root;
}

afterEach(async () => {
  const roots = [...temporaryRoots];
  temporaryRoots.clear();
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
    expect(existsSync(root), `temporary root still exists: ${root}`).toBe(false);
  }
});

describe('lint:agent-sizes', () => {
  it('does not allow-list oversized deployed agents', () => {
    expect(AGENT_DEF_SIZE_ALLOWLIST).toEqual({});
  });

  it('fails security-auditor when any deployed filename variant exceeds the ceiling', async () => {
    const root = await makeTemporaryRoot();
    await writeAgent(root, '.claude/agents', 'security-auditor.md', AGENT_DEF_CEILING_BYTES + 100);
    await writeAgent(root, '.github/agents', 'security-auditor.agent.md', AGENT_DEF_CEILING_BYTES + 100);

    const result = await scanDeployedAgentDefSizes({ rootDir: root });

    expect(result.allowedOversized).toEqual([]);
    expect(result.violations.map((item) => item.path)).toEqual([
      '.claude/agents/security-auditor.md',
      '.github/agents/security-auditor.agent.md',
    ]);
  });

  it('fails a non-exempt deployed agent over the ceiling', async () => {
    const root = await makeTemporaryRoot();
    await writeAgent(root, '.codex/agents', 'custom-large-agent.toml', AGENT_DEF_CEILING_BYTES + 1);

    const result = await scanDeployedAgentDefSizes({ rootDir: root });
    const report = formatAgentDefSizeReport(result);

    expect(result.violations).toEqual([
      {
        agentId: 'custom-large-agent',
        path: '.codex/agents/custom-large-agent.toml',
        size: AGENT_DEF_CEILING_BYTES + 1,
      },
    ]);
    expect(report).toContain('Oversized deployed agent definitions');
    expect(report).toContain('custom-large-agent.toml');
  });

  it('catches Codex serialization growth from a raw source below the ceiling', async () => {
    const root = await makeTemporaryRoot();
    const relPath = 'agentic/code/frameworks/example/agents/escaped.md';
    const sourcePath = join(root, relPath);
    await mkdir(dirname(sourcePath), { recursive: true });
    const body = Array.from({ length: 1050 }, () => 'quoted "line"').join('\n');
    const source = `---\nname: escaped\ndescription: Serialization regression fixture\n---\n\n${body}\n`;
    expect(Buffer.byteLength(source)).toBeLessThan(AGENT_DEF_CEILING_BYTES);
    await writeFile(sourcePath, source);

    const result = await scanPackagedCodexAgentDefSizes({
      rootDir: root,
      targetPaths: [],
    });

    expect(result.renderFailures).toEqual([]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      agentId: 'escaped',
      path: relPath,
      renderedPath: relPath.replace(/\.md$/, '.toml'),
    });
  });

  it('fails the lint and diagnoses identical deployments at source when bindings cross the ceiling', async () => {
    const root = await makeTemporaryRoot();
    const relative = 'agentic/code/frameworks/example/agents/near-limit.md';
    const sourcePath = join(root, relative);
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'aiwg', version: '1.0.0' }));
    const header = '---\nname: near-limit\ndescription: Bound rules size regression\n---\n\n';
    const raw = addManagedMarker(transformAgent(sourcePath, header + 'x', {}), '1.0.0', 'bundled', 'line-comment');
    const source = header + 'x'.repeat(AGENT_DEF_CEILING_BYTES - Buffer.byteLength(raw) - 30);
    await writeFile(sourcePath, source);
    const rules = join(root, 'agentic/code/frameworks/example/rules');
    await mkdir(rules, { recursive: true });
    await writeFile(join(rules, 'required.md'), '---\nactivation: bound\nsummary: Required fixture policy\nbound_to:\n  agents: [near-limit]\n---\nFollow this rule.\n');
    expect(Buffer.byteLength(addManagedMarker(transformAgent(sourcePath, source, {}), '1.0.0', 'bundled', 'line-comment')))
      .toBeLessThan(AGENT_DEF_CEILING_BYTES);
    const result = await scanPackagedCodexAgentDefSizes({ rootDir: root, targetPaths: [] });
    expect(result.renderFailures).toEqual([]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].size).toBeGreaterThan(AGENT_DEF_CEILING_BYTES);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect(await main(['--root', root])).toBe(1); }
    finally { error.mockRestore(); }

    const render = await createPackagedCodexRenderer(root);
    const deployed = render(sourcePath);
    const agents = join(root, '.codex/agents');
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, 'near-limit.toml'), deployed);
    // Doctor loads provider paths from its selected package, which is synthetic here.
    const providerDir = join(root, 'tools/agents/providers');
    await mkdir(providerDir, { recursive: true });
    await writeFile(join(providerDir, 'codex.mjs'), 'export const paths = { agents: ".codex/agents" };');
    const repo = resolve(__dirname, '../../..');
    const home = join(root, 'home');
    await mkdir(home);
    const doctor = spawnSync(process.execPath, [join(repo, 'tools/cli/doctor.mjs'), '--provider', 'codex', '--no-budget-check'], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
        XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
        XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
        AIWG_ROOT: root, AIWG_HOME: root, NO_COLOR: '1' },
    });
    expect(doctor.error).toBeUndefined();
    expect([0, 1], doctor.stderr).toContain(doctor.status);
    const finding = doctor.stdout.split('\n').find(line => line.includes('Codex Agent def sizes:'));
    expect(finding, doctor.stderr).toContain(`over the 16 KB ceiling at source: ${relative}`);
    expect(finding).toContain('fresh deployment produces identical bytes');
    expect(finding).not.toContain('stale managed');
    expect(finding).not.toContain('aiwg refresh');
  }, 60_000);

  it('keeps the three Codex dispatch regressions below the headroom target', async () => {
    const rootDir = resolve(__dirname, '../../..');
    const result = await scanPackagedCodexAgentDefSizes({ rootDir });

    expect(result.renderFailures).toEqual([]);
    expect(result.targetScanned).toHaveLength(3);
    expect(result.targetViolations).toEqual([]);
    expect(result.targetScanned.every((item) => item.size <= PACKAGED_CODEX_AGENT_TARGET_BYTES)).toBe(true);
  });

  it('preserves each compacted agent core contract and discovery handoff', async () => {
    const rootDir = resolve(__dirname, '../../..');
    const expectations: Array<[string, string[]]> = [
      ['agentic/code/frameworks/forensics-complete/agents/log-analyst.md', [
        '## Required Deliverable',
        '## Quality and Safety Gates',
        'aiwg discover "log analyst worked examples"',
      ]],
      ['agentic/code/frameworks/research-complete/agents/quality-agent.md', [
        '## Required Deliverables',
        '### 4. Apply GRADE Separately',
        'aiwg discover "quality agent worked examples"',
      ]],
      ['agentic/code/frameworks/sdlc-complete/agents/ai-ml-engineer.md', [
        '## Required Deliverables',
        '## Safety and Reliability Constraints',
        'aiwg discover "AI ML engineer worked examples"',
      ]],
    ];

    for (const [relPath, required] of expectations) {
      const content = await readFile(join(rootDir, relPath), 'utf8');
      for (const fragment of required) expect(content).toContain(fragment);
    }
  });
});
