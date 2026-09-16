import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import { main as skillsMain } from '../../../src/skills/cli.js';
import {
  AGENT_SKILL_DEPLOYMENT_SIDECAR,
  AGENT_SKILL_MANAGED_MARKER,
  deployImportedAgentSkill,
  inspectImportedAgentSkillProjection,
  uninstallImportedAgentSkill,
} from '../../../src/skills/deployer.js';
import { importAgentSkill } from '../../../src/skills/importer.js';
import { validateAgentSkillFile } from '../../../src/skills/validator.js';

const IMPORTED_AT = '2026-07-26T12:00:00.000Z';
const AIWG_VERSION = 'test-version';
const ORIGINAL_HERMES_HOME = process.env.HERMES_HOME;
const ORIGINAL_GROKBOT_SKILLS_DIR = process.env.AIWG_GROKBOT_SKILLS_DIR;

let root: string;
let projectDir: string;
let homeDir: string;
let sourceDir: string;

function skillContent(
  name: string,
  description = 'Use this portable fixture to verify managed provider projection.',
): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'license: Apache-2.0',
    'compatibility: Requires a provider that discovers Agent Skills bundles.',
    'metadata:',
    '  fixture: "true"',
    '  owner: "aiwg-tests"',
    'allowed-tools: Read Bash',
    'namespace: fixture',
    'platforms: [all]',
    '---',
    '',
    `# ${name}`,
    '',
    'Read [the guide](references/guide.md) before using the binary fixture.',
    '',
  ].join('\n');
}

function createSource(
  name: string,
  description?: string,
): string {
  const source = path.join(sourceDir, name);
  fs.mkdirSync(path.join(source, 'references', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'empty'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), skillContent(name, description));
  fs.writeFileSync(path.join(source, 'references', 'guide.md'), '# Guide\n');
  fs.writeFileSync(path.join(source, 'references', 'nested', 'detail.md'), '# Detail\n');
  fs.writeFileSync(path.join(source, 'assets', 'fixture.bin'), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(source, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n');
  return source;
}

async function importActive(
  name: string,
  description?: string,
): Promise<string> {
  const source = createSource(name, description);
  await importAgentSkill(
    { kind: 'directory', path: source },
    {
      projectDir,
      profile: 'compatible',
      trust: true,
      activate: true,
      importedAt: IMPORTED_AT,
      aiwgVersion: AIWG_VERSION,
    },
  );
  return source;
}

function deployOptions(target: string, dryRun = false) {
  return {
    projectDir,
    homeDir,
    target,
    dryRun,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-agent-skill-deploy-'));
  projectDir = path.join(root, 'project');
  homeDir = path.join(root, 'home');
  sourceDir = path.join(root, 'sources');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(homeDir);
  fs.mkdirSync(sourceDir);
});

afterEach(() => {
  if (ORIGINAL_HERMES_HOME === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = ORIGINAL_HERMES_HOME;
  if (ORIGINAL_GROKBOT_SKILLS_DIR === undefined) delete process.env.AIWG_GROKBOT_SKILLS_DIR;
  else process.env.AIWG_GROKBOT_SKILLS_DIR = ORIGINAL_GROKBOT_SKILLS_DIR;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('managed Agent Skills provider matrix', () => {
  it('projects one conforming resource bundle through every provider policy', async () => {
    const name = 'provider-matrix-skill';
    const source = await importActive(name);
    const grokbotSkills = path.join(homeDir, 'configured-grokbot-skills');
    fs.mkdirSync(grokbotSkills, { recursive: true });
    process.env.AIWG_GROKBOT_SKILLS_DIR = grokbotSkills;
    const results = PROVIDER_IDS.map((target) => (
      deployImportedAgentSkill(name, deployOptions(target))
    ));

    expect(results.map((item) => item.provider)).toEqual([...PROVIDER_IDS]);
    expect(results.map((item) => [item.provider, item.projectionStatus])).toEqual([
      ['antigravity', 'native'],
      ['claude', 'native'],
      ['codex', 'projected'],
      ['copilot', 'native'],
      ['cursor', 'native'],
      ['deepseek-harness', 'native'],
      ['factory', 'projected'],
      ['grokbot', 'native'],
      ['hermes', 'native'],
      ['opencode', 'native'],
      ['openclaw', 'native'],
      ['openhuman', 'projected'],
      ['pi', 'native'],
      ['omp', 'native'],
      ['warp', 'native'],
      ['windsurf', 'projected'],
      ['generic', 'native'],
    ]);

    for (const result of results) {
      expect(result.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(result.path).toContain(name);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.outcome).toBe(
        ['codex', 'deepseek-harness'].includes(result.provider) ? 'unchanged' : 'deployed',
      );
      expect(fs.readFileSync(path.join(result.path, AGENT_SKILL_MANAGED_MARKER), 'utf8'))
        .toBe('aiwg-agent-skill-v1\n');
      const sidecar = JSON.parse(fs.readFileSync(
        path.join(result.path, AGENT_SKILL_DEPLOYMENT_SIDECAR),
        'utf8',
      )) as Record<string, unknown>;
      expect(sidecar).toMatchObject({
        schemaVersion: 1,
        name,
        provider: ['codex', 'deepseek-harness'].includes(result.provider)
          ? 'antigravity'
          : result.provider,
        projectionStatus: ['codex', 'deepseek-harness'].includes(result.provider)
          ? 'native'
          : result.projectionStatus,
        sourceDigest: result.sourceDigest,
        portable: {
          aiwg: {
            namespace: 'fixture',
            platforms: ['all'],
          },
          provenance: {
            sourceKind: 'directory',
            sourceDigest: result.sourceDigest,
          },
          validationProfile: 'compatible',
          trust: {
            state: 'trusted',
            activation: 'active',
          },
        },
      });

      const validation = validateAgentSkillFile(path.join(result.path, 'SKILL.md'), {
        profile: 'strict',
        directoryName: name,
        skillRoot: result.path,
        checkResources: true,
      });
      expect(validation.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
      expect(validation.frontmatter).toMatchObject({
        name,
        license: 'Apache-2.0',
        compatibility: 'Requires a provider that discovers Agent Skills bundles.',
        metadata: {
          fixture: 'true',
          owner: 'aiwg-tests',
        },
        'allowed-tools': 'Read Bash',
      });
      expect(validation.frontmatter).not.toHaveProperty('namespace');
      expect(validation.frontmatter).not.toHaveProperty('platforms');
      if (result.provider === 'factory') {
        expect(validation.frontmatter?.description).toContain(
          'Use when relevant to the task.',
        );
      }
      for (const relativePath of [
        'references/guide.md',
        'references/nested/detail.md',
        'assets/fixture.bin',
        'scripts/run.sh',
      ]) {
        expect(fs.readFileSync(path.join(result.path, relativePath)))
          .toEqual(fs.readFileSync(path.join(source, relativePath)));
      }
      expect(fs.statSync(path.join(result.path, 'empty')).isDirectory()).toBe(true);
    }

    expect(results.find((item) => item.provider === 'codex')?.path)
      .toBe(path.join(projectDir, '.agents', 'skills', name));
    expect(results.find((item) => item.provider === 'openhuman')?.path)
      .toBe(path.join(homeDir, '.openhuman', 'skills', name));
    expect(results.find((item) => item.provider === 'hermes')?.path)
      .toBe(path.join(homeDir, '.hermes', 'skills', name));
    expect(results.find((item) => item.provider === 'grokbot')?.path)
      .toBe(path.join(homeDir, 'configured-grokbot-skills', name));
    expect(fs.existsSync(path.join(projectDir, '.openhuman'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.hermes'))).toBe(false);
  });

  it('deploys a managed Hermes skill to the active HERMES_HOME', async () => {
    const name = 'hermes-profile-skill';
    const hermesHome = path.join(root, 'hermes-profile');
    process.env.HERMES_HOME = hermesHome;
    await importActive(name);

    const result = deployImportedAgentSkill(name, {
      projectDir,
      target: 'hermes',
      dryRun: false,
    });

    expect(result.path).toBe(path.join(hermesHome, 'skills', name));
    expect(fs.existsSync(path.join(result.path, 'SKILL.md'))).toBe(true);
  });

  it('reports provider incompatibility instead of truncating standard metadata', async () => {
    const name = 'codex-limit-skill';
    const description = 'd'.repeat(501);
    await importActive(name, description);

    const result = deployImportedAgentSkill(name, deployOptions('codex'));

    expect(result).toMatchObject({
      outcome: 'blocked',
      projectionStatus: 'degraded',
    });
    expect(result.reasons.join(' ')).toContain('no truncation was applied');
    expect(fs.existsSync(result.path)).toBe(false);
  });
});

describe('managed Agent Skills deployment lifecycle', () => {
  it('makes dry-run write-free and repeated deployment byte-idempotent', async () => {
    const name = 'idempotent-skill';
    await importActive(name);
    const planned = deployImportedAgentSkill(name, deployOptions('claude', true));
    expect(planned.outcome).toBe('planned');
    expect(fs.existsSync(planned.path)).toBe(false);

    const first = deployImportedAgentSkill(name, deployOptions('claude'));
    const firstSkill = fs.readFileSync(path.join(first.path, 'SKILL.md'));
    const firstMtime = fs.statSync(first.path).mtimeMs;
    const second = deployImportedAgentSkill(name, deployOptions('claude'));
    expect(second.outcome).toBe('unchanged');
    expect(fs.readFileSync(path.join(second.path, 'SKILL.md'))).toEqual(firstSkill);
    expect(fs.statSync(second.path).mtimeMs).toBe(firstMtime);
  });

  it('updates atomically and removes only managed targets', async () => {
    const name = 'managed-update-skill';
    const source = await importActive(name);
    const first = deployImportedAgentSkill(name, deployOptions('generic'));
    fs.writeFileSync(path.join(first.path, 'stale-managed-resource.txt'), 'stale\n');
    fs.appendFileSync(path.join(source, 'references', 'guide.md'), 'Updated.\n');
    await importAgentSkill(
      { kind: 'directory', path: source },
      {
        projectDir,
        profile: 'compatible',
        update: true,
        trust: true,
        activate: true,
        importedAt: '2026-07-26T13:00:00.000Z',
        aiwgVersion: AIWG_VERSION,
      },
    );

    const oldProjectionRemoval = uninstallImportedAgentSkill(
      name,
      deployOptions('generic', true),
    );
    expect(oldProjectionRemoval.sourceDigest).toBe(first.sourceDigest);

    const updated = deployImportedAgentSkill(name, deployOptions('generic'));
    expect(updated.outcome).toBe('updated');
    expect(updated.sourceDigest).not.toBe(first.sourceDigest);
    expect(fs.readFileSync(path.join(updated.path, 'references', 'guide.md'), 'utf8'))
      .toContain('Updated.');
    expect(fs.existsSync(path.join(updated.path, 'stale-managed-resource.txt')))
      .toBe(false);

    const planned = uninstallImportedAgentSkill(name, deployOptions('generic', true));
    expect(planned.outcome).toBe('planned');
    expect(fs.existsSync(updated.path)).toBe(true);
    const removed = uninstallImportedAgentSkill(name, deployOptions('generic'));
    expect(removed.outcome).toBe('removed');
    expect(fs.existsSync(updated.path)).toBe(false);
    expect(uninstallImportedAgentSkill(name, deployOptions('generic')).outcome)
      .toBe('absent');
  });

  it('does not overwrite or uninstall a user-owned collision', async () => {
    const name = 'collision-safe-skill';
    await importActive(name);
    const target = path.join(projectDir, '.claude', 'skills', name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'user owned\n');

    const deployed = deployImportedAgentSkill(name, deployOptions('claude'));
    expect(deployed).toMatchObject({
      outcome: 'blocked',
      projectionStatus: 'degraded',
    });
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('user owned\n');

    const removed = uninstallImportedAgentSkill(name, deployOptions('claude'));
    expect(removed.outcome).toBe('blocked');
    expect(fs.existsSync(target)).toBe(true);

    fs.writeFileSync(
      path.join(target, AGENT_SKILL_MANAGED_MARKER),
      'aiwg-agent-skill-v1\n',
    );
    expect(uninstallImportedAgentSkill(name, deployOptions('claude')).outcome)
      .toBe('blocked');
    expect(fs.existsSync(target)).toBe(true);
  });

  it('rejects non-portable uninstall names before resolving a target path', () => {
    expect(() => uninstallImportedAgentSkill(
      '../../outside',
      deployOptions('generic'),
    )).toThrow('Agent Skill name must be');
    expect(fs.existsSync(path.join(root, 'outside'))).toBe(false);
  });

  it('restores the prior projection when atomic promotion fails', async () => {
    const name = 'rollback-projection-skill';
    const source = await importActive(name);
    const first = deployImportedAgentSkill(name, deployOptions('generic'));
    const original = fs.readFileSync(path.join(first.path, 'SKILL.md'));
    fs.appendFileSync(path.join(source, 'SKILL.md'), '\nUpdated body.\n');
    await importAgentSkill(
      { kind: 'directory', path: source },
      {
        projectDir,
        profile: 'compatible',
        update: true,
        trust: true,
        activate: true,
        importedAt: '2026-07-26T13:00:00.000Z',
        aiwgVersion: AIWG_VERSION,
      },
    );

    const rename = fs.renameSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((
      oldPath: fs.PathLike,
      newPath: fs.PathLike,
    ) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated deployment promotion failure');
      rename(oldPath, newPath);
    });

    expect(() => deployImportedAgentSkill(name, deployOptions('generic')))
      .toThrow('simulated deployment promotion failure');
    expect(fs.readFileSync(path.join(first.path, 'SKILL.md'))).toEqual(original);
    expect(fs.readdirSync(path.dirname(first.path))
      .filter((entry) => entry.startsWith(`.${name}.`))).toEqual([]);
  });

  it('detects sidecar, resource, and strict projection drift', async () => {
    const name = 'inspection-skill';
    await importActive(name);
    const deployed = deployImportedAgentSkill(name, deployOptions('claude'));
    expect(inspectImportedAgentSkillProjection(name, deployOptions('claude')))
      .toMatchObject({
        exists: true,
        managed: true,
        matches: true,
      });

    fs.appendFileSync(path.join(deployed.path, 'references', 'guide.md'), 'Drift.\n');
    expect(inspectImportedAgentSkillProjection(name, deployOptions('claude')))
      .toMatchObject({
        exists: true,
        managed: true,
        matches: false,
      });
  });
});

describe('skills deploy CLI', () => {
  it('emits deterministic JSON and human provider results', async () => {
    const name = 'cli-deploy-skill';
    await importActive(name);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await skillsMain(['deploy', name, '--target', 'generic', '--json']);
    const jsonText = log.mock.calls.at(-1)?.[0] as string;
    const output = JSON.parse(jsonText) as {
      schemaVersion: number;
      operation: string;
      results: Array<Record<string, unknown>>;
    };
    expect(output).toMatchObject({
      schemaVersion: 1,
      operation: 'deploy',
    });
    expect(output.results).toEqual([
      expect.objectContaining({
        provider: 'generic',
        outcome: 'deployed',
        projectionStatus: 'native',
      }),
    ]);

    log.mockClear();
    await skillsMain(['uninstall', name, '--target', 'generic']);
    const human = log.mock.calls.flat().join('\n');
    expect(human).toContain('generic');
    expect(human).toContain('removed');
    expect(human).toContain(path.join(projectDir, 'skills', name));
  });
});

describe('strict projection serialization', () => {
  it('keeps standard YAML values typed after projection', async () => {
    const name = 'yaml-projection-skill';
    await importActive(name);
    const deployed = deployImportedAgentSkill(name, deployOptions('generic'));
    const content = fs.readFileSync(path.join(deployed.path, 'SKILL.md'), 'utf8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(parse(frontmatter)).toMatchObject({
      name,
      metadata: {
        fixture: 'true',
        owner: 'aiwg-tests',
      },
    });
  });
});

describe('grokbot Agent Skills fail-closed deploy (#212)', () => {
  it('blocks deploy without AIWG_GROKBOT_SKILLS_DIR and invents no home skill root', async () => {
    delete process.env.AIWG_GROKBOT_SKILLS_DIR;
    const name = 'grokbot-blocked-skill';
    await importActive(name);
    const result = deployImportedAgentSkill(name, deployOptions('grokbot'));
    expect(result.outcome).toBe('blocked');
    expect(result.projectionStatus).toBe('unsupported');
    expect(result.reasons.join(' ')).toMatch(/AIWG_GROKBOT_SKILLS_DIR/);
    expect(fs.existsSync(path.join(homeDir, 'grokbot-skills'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.grokbot'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, 'AIWG_GROKBOT_SKILLS_DIR'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.cursor'))).toBe(false);
  });

  it('deploys under absolute AIWG_GROKBOT_SKILLS_DIR only', async () => {
    const name = 'grokbot-configured-skill';
    await importActive(name);
    const skillsRoot = path.join(homeDir, 'real-grokbot-skills');
    fs.mkdirSync(skillsRoot, { recursive: true });
    process.env.AIWG_GROKBOT_SKILLS_DIR = skillsRoot;
    const result = deployImportedAgentSkill(name, deployOptions('grokbot'));
    expect(result.outcome).toBe('deployed');
    expect(result.path).toBe(path.join(skillsRoot, name));
    expect(fs.existsSync(path.join(result.path, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, 'grokbot-skills'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.cursor'))).toBe(false);
  });

  it('rejects relative AIWG_GROKBOT_SKILLS_DIR overrides', async () => {
    const name = 'grokbot-relative-skill';
    await importActive(name);
    process.env.AIWG_GROKBOT_SKILLS_DIR = 'relative-skills';
    const result = deployImportedAgentSkill(name, deployOptions('grokbot'));
    expect(result.outcome).toBe('blocked');
    expect(fs.existsSync(path.join(projectDir, 'relative-skills'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, 'relative-skills'))).toBe(false);
  });
});

