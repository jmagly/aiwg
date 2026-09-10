/**
 * Integration tests for `aiwg use all` disallow-list behaviour
 *
 * Validates that:
 *   - `aiwg use all` deploys every addon except those in the disallow list
 *   - `aiwg use aiwg-dev` remains available as an explicit contributor install
 *   - `aiwg use <any-valid-addon>` works without being in a hardcoded list
 *   - New addons added to agentic/code/addons/ are auto-discovered
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';
// @ts-expect-error — .mjs provider module without type declarations
import {
  listOnDemandRuleFiles,
  onDemandRuleNames,
} from '../../tools/agents/providers/base.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const BIN = path.join(REPO_ROOT, 'bin/aiwg.mjs');
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'aiwg-use-cli-home-'));

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function isolatedCliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: TEST_HOME,
    USERPROFILE: TEST_HOME,
    XDG_CACHE_HOME: path.join(TEST_HOME, '.cache'),
    XDG_CONFIG_HOME: path.join(TEST_HOME, '.config'),
    XDG_DATA_HOME: path.join(TEST_HOME, '.local', 'share'),
    NO_UPDATE_NOTIFIER: '1',
    ...overrides,
  };
}

function runAiwg(
  args: string[],
  cwd: string = os.tmpdir()
): { stdout: string; stderr: string; exitCode: number } {
  if (args.includes('use') && !args.includes('--copy-all') && !args.includes('--dry-run')) {
    args = [...args, '--copy-all'];
  }
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    // Do not inherit the operator's ~/.aiwg/channel.json. A dev/edge pointer
    // can otherwise route this release-candidate test through another checkout.
    env: isolatedCliEnv(),
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function runAiwgWithEnv(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: isolatedCliEnv(env),
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function canInitGit(): boolean {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'aiwg-git-check-'));
  try {
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const GIT_AVAILABLE = canInitGit();

const EXPECTED_ON_DEMAND_RULE_NAMES: string[] = onDemandRuleNames(listOnDemandRuleFiles(REPO_ROOT));
const ISSUE_1784_MISSING_EXAMPLES = [
  'activity-log',
  'context-budget',
  'diagram-generation',
  'voice-framework',
  'prose-bridge',
  'scoped-reasoning',
];
const TESTING_QUALITY_SKILLS = [
  'tdd-enforce',
  'mutation-test',
  'flaky-detect',
  'flaky-fix',
  'generate-factory',
  'test-sync',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeProject(): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-use-all-'));
  if (GIT_AVAILABLE) {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  }
  return dir;
}

async function cleanProject(dir: string) {
  if (existsSync(dir)) await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Disallow-list unit-level integration
// ---------------------------------------------------------------------------

describe('aiwg use — disallow list', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-use-disallow-'));
  });

  afterEach(async () => {
    await cleanProject(projectDir);
  });

  it('accepts aiwg-dev as an explicit install (contributor workflow)', () => {
    // aiwg-dev is excluded from `use all` but must be installable explicitly
    const result = runAiwg(['use', 'aiwg-dev', '--dry-run'], projectDir);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  });

  it('rejects unknown addon names', () => {
    const result = runAiwg(['use', 'this-does-not-exist-abc123'], projectDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/unknown target|not found/i);
  });

  it('accepts a real addon by name without it being in a hardcoded list', () => {
    // auto-memory is new and was NOT in the old VALID_ADDONS hardcoded list
    const result = runAiwg(['use', 'auto-memory', '--dry-run'], projectDir);
    // dry-run exit code 0 means the addon was recognised and would be deployed
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  });

  it('keeps every bundled addon manifest identity aligned with its directory', async () => {
    const addonsRoot = path.join(REPO_ROOT, 'agentic/code/addons');
    const entries = await fs.readdir(addonsRoot, { withFileTypes: true });

    for (const entry of entries.filter(candidate => candidate.isDirectory())) {
      const manifestPath = path.join(addonsRoot, entry.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      expect(manifest.id, manifestPath).toBe(entry.name);
    }
  });
});

// ---------------------------------------------------------------------------
// aiwg use all — deployment coverage
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('aiwg use all — deployment coverage', { timeout: 60_000 }, () => {
  let projectDir: string;
  const fullUseAllArgs = (target: string) => ['use', 'all', '--target', target];

  beforeEach(async () => {
    projectDir = await makeProject();
  });

  afterEach(async () => {
    await cleanProject(projectDir);
  });

  it('deploys to .claude/.aiwg/skills/ without errors', () => {
    const result = runAiwg(fullUseAllArgs(projectDir), projectDir);
    expect(result.exitCode, `aiwg use all failed (exit ${result.exitCode}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
    const skillsDir = path.join(projectDir, '.claude', '.aiwg', 'skills');
    expect(existsSync(skillsDir)).toBe(true);
  });

  it('reports deployed and indexed skill counts in separate sections', () => {
    const result = runAiwg(fullUseAllArgs(projectDir), projectDir);
    expect(result.exitCode, `aiwg use all failed (exit ${result.exitCode}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

    expect(result.stdout).toMatch(/Installing complete AIWG surface/);
    expect(result.stdout).toMatch(/Deployed to Claude Code \(claude\)[\s\S]*\bSkills \d+\b/);
    expect(result.stdout).toMatch(/Indexed for discovery[\s\S]*\bskill \d+\b/);
    expect(result.stdout).not.toMatch(/Discoverable skills\s+\d+ deployed/);
  }, 60_000);

  it('deploys more skills than the old hardcoded 4-addon set would produce', async () => {
    const result = runAiwg(fullUseAllArgs(projectDir), projectDir);
    expect(result.exitCode).toBe(0);

    const skillsDir = path.join(projectDir, '.claude', '.aiwg', 'skills');
    if (!existsSync(skillsDir)) return; // guard for environments without write access

    const deployed = await fs.readdir(skillsDir);
    // Old behaviour only deployed aiwg-utils + ralph skills (~30 total)
    // New behaviour deploys all addons, should be substantially more
    expect(deployed.length).toBeGreaterThan(30);
  });

  it('does not deploy aiwg-dev skills', async () => {
    runAiwg(fullUseAllArgs(projectDir), projectDir);
    const skillsDir = path.join(projectDir, '.claude', '.aiwg', 'skills');
    if (!existsSync(skillsDir)) return;

    // aiwg-dev skills: validate-component, validate-addon, dev-doctor, link-check
    const devSkills = ['validate-component', 'validate-addon', 'dev-doctor', 'link-check'];
    const deployed = await fs.readdir(skillsDir);
    for (const devSkill of devSkills) {
      expect(deployed).not.toContain(devSkill);
    }
  });

  it('deploys addons that were previously missing from the hardcoded list', async () => {
    const result = runAiwg(fullUseAllArgs(projectDir), projectDir);
    expect(result.exitCode).toBe(0);

    const skillsDir = path.join(projectDir, '.claude', '.aiwg', 'skills');
    if (!existsSync(skillsDir)) return;

    const deployed = await fs.readdir(skillsDir);

    // These addons have skills and were NOT in the old VALID_ADDONS list
    // They should now appear after legacy full `aiwg use all`
    const previouslyMissing = [
      'voice-apply',      // voice-framework
      'curate',           // media-curator
      'agent-loop',       // ralph (was hardcoded but let's verify)
      'project-awareness', // aiwg-utils (was hardcoded but let's verify)
    ];

    for (const skill of previouslyMissing) {
      expect(deployed).toContain(skill);
    }
  });

  it('deploys agents alongside skills', async () => {
    runAiwg(fullUseAllArgs(projectDir), projectDir);
    const agentsDir = path.join(projectDir, '.claude', 'agents');
    if (!existsSync(agentsDir)) return;

    const agents = await fs.readdir(agentsDir);
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.some(a => a.endsWith('.md'))).toBe(true);
  });

  it('mirrors Claude setup skills as slash commands', async () => {
    const result = runAiwg(fullUseAllArgs(projectDir), projectDir);
    expect(result.exitCode).toBe(0);

    const commandsDir = path.join(projectDir, '.claude', 'commands');
    expect(existsSync(path.join(commandsDir, 'aiwg-setup-project.md'))).toBe(true);
    expect(existsSync(path.join(commandsDir, 'aiwg-update-claude.md'))).toBe(true);
    expect(existsSync(path.join(commandsDir, 'aiwg-update-agents-md.md'))).toBe(true);
  });

  it('mirrors Claude kernel self-maintenance skills as bootstrap slash commands', async () => {
    // Kernel bootstrap functions are copied in as `/`-commands for direct
    // access (not discovery-only). Supersedes the #1382 gate that kept these
    // native-skill-only on Claude; the direct entry point is worth the
    // skill+command redundancy that the standard operator set already ships.
    const result = runAiwg(fullUseAllArgs(projectDir), projectDir);
    expect(result.exitCode).toBe(0);

    const commandsDir = path.join(projectDir, '.claude', 'commands');
    const kernelBootstrapCommands = [
      'aiwg-regenerate.md',
      'aiwg-doctor.md',
      'aiwg-refresh.md',
      'aiwg-status.md',
      'aiwg-help.md',
      'aiwg-issue.md',
      'aiwg-pr.md',
      'use.md',
      'steward.md',
    ];

    for (const file of kernelBootstrapCommands) {
      expect(existsSync(path.join(commandsDir, file)), `${file} should be copied in as a Claude bootstrap command`).toBe(true);
    }
  });

  it('keeps Codex bulk deployment kernel-only by default', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-use-all-codex-home-'));
    try {
      const agentsDir = path.join(projectDir, '.codex', 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, 'stale-aiwg.toml'), '# aiwg:managed v0 test\nname = "stale"\n');
      await fs.writeFile(path.join(agentsDir, 'operator.toml'), 'name = "operator"\n');
      const result = runAiwgWithEnv(
        ['use', 'all', '--provider', 'codex', '--target', projectDir],
        projectDir,
        { HOME: homeDir, USERPROFILE: homeDir },
      );
      expect(result.exitCode, `aiwg use all --provider codex failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

      const regenerateSkill = path.join(projectDir, '.agents', 'skills', 'aiwg-regenerate', 'SKILL.md');
      expect(existsSync(regenerateSkill), 'Codex should retain $aiwg-regenerate in .agents/skills after addon deploys').toBe(true);
      const regenerateMetadata = await fs.readFile(path.join(projectDir, '.agents', 'skills', 'aiwg-regenerate', 'agents', 'openai.yaml'), 'utf-8');
      expect(regenerateMetadata).toContain('display_name: "AIWG Regenerate"');
      expect(existsSync(path.join(projectDir, '.agents', 'skills', 'voice-apply', 'SKILL.md')), 'Codex default deploy should not copy standard skills into the native $ search path').toBe(false);

      const skillDirs = await fs.readdir(path.join(projectDir, '.agents', 'skills'), { withFileTypes: true });
      expect(skillDirs.filter(entry => entry.isDirectory()).length).toBeLessThan(100);

      const codexAgentsDir = path.join(projectDir, '.codex', 'agents');
      const codexAgents = existsSync(codexAgentsDir)
        ? (await fs.readdir(codexAgentsDir)).filter(name => name.endsWith('.toml'))
        : [];
      expect(codexAgents).toEqual(['operator.toml']);

      const gitignore = await fs.readFile(path.join(projectDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.codex/');
      expect(gitignore).toContain('.agents/');
      expect(result.stdout).toMatch(/Deployed to OpenAI Codex \(codex\)[\s\S]*\bSkills [1-9]\d*\b/);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('deploys Pi prompts and kernel skills for the default bulk install', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-use-all-pi-home-'));
    try {
      const result = runAiwgWithEnv(
        ['use', 'all', '--provider', 'pi', '--target', projectDir],
        projectDir,
        { HOME: homeDir, USERPROFILE: homeDir },
      );
      expect(result.exitCode, `aiwg use all --provider pi failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(existsSync(path.join(projectDir, '.agents', 'skills', 'aiwg-regenerate', 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(projectDir, '.pi', 'prompts', 'address-issues.md'))).toBe(true);
      expect(existsSync(path.join(projectDir, 'AGENTS.md'))).toBe(true);
      expect(existsSync(path.join(projectDir, '.pi', 'settings.json'))).toBe(false);
      expect(result.stdout).toMatch(/Deployed to Pi Coding Agent \(pi\)[\s\S]*\bCommands [1-9]\d*\b[\s\S]*\bSkills [1-9]\d*\b/);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('mirrors Pi user-scope resources through PI_CODING_AGENT_DIR', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-use-pi-user-home-'));
    const agentDir = path.join(homeDir, 'custom-pi-agent');
    try {
      const result = runAiwgWithEnv(
        ['use', 'sdlc', '--provider', 'pi', '--target', projectDir, '--scope', 'user'],
        projectDir,
        { HOME: homeDir, USERPROFILE: homeDir, PI_CODING_AGENT_DIR: agentDir },
      );
      expect(result.exitCode, `Pi user-scope deployment failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(existsSync(path.join(agentDir, 'skills', 'sdlc-quickref', 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(agentDir, 'prompts', 'address-issues.md'))).toBe(true);
      expect(existsSync(path.join(homeDir, '.agents', 'skills', 'sdlc-quickref', 'SKILL.md'))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps Claude bulk deployment kernel-only by default', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-use-all-claude-home-'));
    try {
      const agentsDir = path.join(projectDir, '.claude', 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, 'stale-aiwg.md'), '<!-- aiwg:managed v0 test -->\n# stale\n');
      await fs.writeFile(path.join(agentsDir, 'operator.md'), '# operator\n');
      const result = runAiwgWithEnv(
        ['use', 'all', '--provider', 'claude', '--target', projectDir],
        projectDir,
        { HOME: homeDir, USERPROFILE: homeDir },
      );
      expect(result.exitCode, `aiwg use all --provider claude failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(existsSync(path.join(projectDir, '.claude', 'skills', 'aiwg-utils-quickref', 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(projectDir, '.claude', 'skills', 'voice-apply', 'SKILL.md'))).toBe(false);
      const agents = existsSync(agentsDir)
        ? (await fs.readdir(agentsDir)).filter(name => name.endsWith('.md'))
        : [];
      expect(agents).toEqual(['operator.md']);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps managed bulk artifacts intact during a kernel-only dry run', async () => {
    const agentsDir = path.join(projectDir, '.codex', 'agents');
    await fs.mkdir(agentsDir, { recursive: true });
    const staleAgent = path.join(agentsDir, 'stale-aiwg.toml');
    await fs.writeFile(staleAgent, '# aiwg:managed v0 test\nname = "stale"\n');

    const result = runAiwgWithEnv(
      ['use', 'all', '--provider', 'codex', '--target', projectDir, '--dry-run'],
      projectDir,
      {},
    );
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(existsSync(staleAgent)).toBe(true);
  }, 60_000);

  it('deploys explicit testing-quality skills to the Codex native skill surface', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-testing-quality-codex-home-'));
    try {
      const result = runAiwgWithEnv(
        ['use', 'testing-quality', '--provider', 'codex', '--target', projectDir],
        projectDir,
        { HOME: homeDir, USERPROFILE: homeDir },
      );
      expect(result.exitCode, `aiwg use testing-quality --provider codex failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

      for (const skill of TESTING_QUALITY_SKILLS) {
        expect(
          existsSync(path.join(projectDir, '.agents', 'skills', skill, 'SKILL.md')),
          `${skill} should be deployed to .agents/skills for Codex when testing-quality is explicitly installed`,
        ).toBe(true);
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  // One bounded CLI child per case; each provider gets an isolated project and
  // a distinct failure identity instead of sharing a 90s budget for two calls.
  it.each(['claude', 'codex'])('writes complete RULES-ONDEMAND indexes for %s after real aiwg use all (#1784)', async (provider) => {
    const result = runAiwg(['use', 'all', '--provider', provider, '--target', projectDir], projectDir);
    expect(result.exitCode, `aiwg use all --provider ${provider} failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

    const rulesDir = provider === 'claude'
      ? path.join(projectDir, '.claude', 'rules')
      : path.join(projectDir, '.codex', 'rules');
    const body = await fs.readFile(path.join(rulesDir, 'RULES-ONDEMAND.md'), 'utf8');
    const actual = [...body.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]).sort();

    expect(actual).toEqual(EXPECTED_ON_DEMAND_RULE_NAMES);
    expect(actual).toEqual(expect.arrayContaining(ISSUE_1784_MISSING_EXAMPLES));
  }, 90_000);
});

// ---------------------------------------------------------------------------
// new-project skill — rename validation
// ---------------------------------------------------------------------------

describe('new-project skill rename', () => {
  it('new-project skill exists in source tree', async () => {
    const skillPath = path.join(
      REPO_ROOT,
      'agentic/code/addons/aiwg-utils/skills/new-project/SKILL.md'
    );
    expect(existsSync(skillPath)).toBe(true);
  });

  it('old new/ skill directory no longer exists in source tree', () => {
    const oldPath = path.join(
      REPO_ROOT,
      'agentic/code/addons/aiwg-utils/skills/new/SKILL.md'
    );
    expect(existsSync(oldPath)).toBe(false);
  });

  it('new-project is listed in the aiwg-utils manifest', async () => {
    const manifestPath = path.join(
      REPO_ROOT,
      'agentic/code/addons/aiwg-utils/manifest.json'
    );
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    expect(manifest.skills).toContain('new-project');
    expect(manifest.skills).not.toContain('new');
  });
});
