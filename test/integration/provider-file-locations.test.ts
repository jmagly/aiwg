import { mkdtempSync } from '../helpers/temp-dir.js';
/**
 * Provider File Locations Integration Tests
 *
 * Comprehensive test suite validating that each provider deploys files to
 * the correct locations. This test suite validates actual filesystem state
 * after deployment.
 *
 * Issue #21: Fix provider deployment file locations
 *
 * Expected locations by provider (universal deployment - all 4 artifact types):
 * - Claude:   .claude/agents/, .claude/commands/, .claude/.aiwg/skills/, .claude/rules/
 * - Codex:    .codex/agents/, .codex/rules/, .agents/skills/ (project) + ~/.codex/prompts/ (home); legacy ~/.codex/skills/ pruned (#766)
 * - Factory:  .factory/droids/, .factory/commands/, .factory/skills/, .factory/rules/
 * - Copilot:  .github/agents/ (.agent.md), .github/prompts/ (.prompt.md), .github/skills/, .github/instructions/ (.instructions.md)
 * - Cursor:   .cursor/agents/, .cursor/commands/, .cursor/skills/, .cursor/rules/
 * - OpenCode: .opencode/skill/, .opencode/rule/ (agents/commands not file-based)
 * - Warp:     .warp/skills/ (native) + WARP.md (aggregated agents/commands/rules)
 * - Windsurf: .windsurf/workflows/, .windsurf/skills/, .windsurf/rules/, .agents/skills/ + AGENTS.md (aggregated agents), .windsurfrules (deprecated stub)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../..');
function canInitGit(): boolean {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-git-check-'));
  try {
    execFileSync('git', ['init'], { timeout: 60_000, cwd: tmpDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const GIT_INIT_AVAILABLE = canInitGit();

// Check if tsx is available (needed for bin/aiwg.mjs which goes through router-loader)
function isTsxAvailable(): boolean {
  try {
    const result = spawnSync('npx', ['tsx', '--version'], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const TSX_AVAILABLE = isTsxAvailable();
let TEST_BASE: string;
beforeAll(() => { TEST_BASE = mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-tests-')); });

interface ProviderConfig {
  name: string;
  projectPaths: string[];       // Paths that should exist in project dir
  homePaths?: string[];         // Paths that should exist in home dir
  rootFiles?: string[];         // Files that should exist in project root
  forbiddenPaths?: string[];    // Paths that should NOT exist
  fileExtension: string;        // Expected file extension for artifacts
  minArtifacts?: number;        // Minimum number of artifacts expected
}

const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    name: 'claude',
    projectPaths: ['.claude/agents', '.claude/commands', '.claude/.aiwg/skills', '.claude/rules'],
    forbiddenPaths: [],
    fileExtension: '.md',
    minArtifacts: 10,
  },
  codex: {
    name: 'codex',
    // Skills → project .agents/skills/ (cross-provider canonical, codex-scanned).
    // Legacy ~/.codex/skills/ is no longer written and is pruned on deploy (#766).
    projectPaths: ['.codex/agents', '.codex/rules', '.agents/skills'],  // Commands → ~/.codex/prompts/ (home)
    homePaths: ['~/.codex/prompts'],
    forbiddenPaths: ['.claude'],  // Should NOT create Claude dirs
    fileExtension: '.md',
    minArtifacts: 5,
  },
  factory: {
    name: 'factory',
    projectPaths: ['.factory/droids', '.factory/commands', '.factory/.aiwg/skills', '.factory/rules'],
    forbiddenPaths: ['.claude', '.codex'],
    fileExtension: '.md',
    minArtifacts: 5,
  },
  copilot: {
    name: 'copilot',
    projectPaths: ['.github/agents', '.github/prompts', '.github/.aiwg/skills', '.github/instructions'],
    forbiddenPaths: ['.claude', '.codex', '.factory'],
    fileExtension: '.agent.md',  // Copilot uses .agent.md for agents
    minArtifacts: 5,
  },
  cursor: {
    name: 'cursor',
    projectPaths: ['.cursor/agents', '.cursor/commands', '.cursor/.aiwg/skills', '.cursor/rules'],
    forbiddenPaths: ['.claude', '.codex', '.factory', '.github/agents'],
    fileExtension: '.md',  // Most artifacts are .md; rules are .mdc
    minArtifacts: 5,
  },
  opencode: {
    name: 'opencode',
    projectPaths: ['.opencode/agent', '.opencode/.aiwg/skill', '.opencode/rule'],
    forbiddenPaths: ['.claude', '.codex', '.cursor', '.opencode/commands'],
    fileExtension: '.md',
    minArtifacts: 5,
  },
  warp: {
    name: 'warp',
    projectPaths: ['.warp/.aiwg/skills'],  // Only skills are natively discovered; agents/commands/rules via WARP.md
    rootFiles: ['WARP.md'],
    forbiddenPaths: ['.claude/agents'],
    fileExtension: '.md',
    minArtifacts: 5,
  },
  windsurf: {
    name: 'windsurf',
    projectPaths: ['.windsurf/.aiwg/skills', '.windsurf/rules', '.agents/skills'],  // Agents → aggregated AGENTS.md; commands → skills (#551); cross-agent skills (#576)
    rootFiles: ['AGENTS.md', '.windsurfrules'],  // .windsurfrules is now a deprecated stub pointing to .windsurf/rules/aiwg-orchestration.md
    forbiddenPaths: ['.claude/agents', '.codex'],
    fileExtension: '.md',
    minArtifacts: 5,
  },
};

// Helper to create isolated test directory
async function createTestEnv(provider: string): Promise<{ projectDir: string; homeDir: string }> {
  const timestamp = Date.now();
  const projectDir = path.join(TEST_BASE, `${provider}-project-${timestamp}`);
  const homeDir = path.join(TEST_BASE, `${provider}-home-${timestamp}`);

  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });

  // Initialize git (some providers require it)
  execFileSync('git', ['init'], { timeout: 60_000, cwd: projectDir, stdio: 'pipe' });

  return { projectDir, homeDir };
}

// Helper to clean up test directory
async function cleanupTestEnv(projectDir: string, homeDir: string): Promise<void> {
  if (projectDir) {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
  if (homeDir) {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

// Helper to run deployment
function runDeploy(
  provider: string,
  projectDir: string,
  homeDir: string,
  extraArgs: string[] = []
): string {
  if (!extraArgs.includes("--copy-all")) extraArgs = [...extraArgs, "--copy-all"];
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };

  const args = [
    '--provider', provider,
    '--mode', 'sdlc',
    '--target', projectDir,
    '--deploy-commands',
    '--deploy-skills',
    '--deploy-rules',
    ...extraArgs,
  ];

  return execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, 'tools/agents/deploy-agents.mjs'), ...args],
    { timeout: 60_000, cwd: REPO_ROOT, env, encoding: 'utf-8' }
  );
}

// Helper to list files recursively
async function listFilesRecursive(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await listFilesRecursive(fullPath));
      } else {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return files;
}

// Helper to check if path exists
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!GIT_INIT_AVAILABLE)('Provider File Locations', () => {
  // Ensure base test directory exists
  beforeEach(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
  });

  describe.each(Object.keys(PROVIDERS))('%s provider', (providerName) => {
    const config = PROVIDERS[providerName];
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      const env = await createTestEnv(providerName);
      projectDir = env.projectDir;
      homeDir = env.homeDir;
    });

    afterEach(async () => {
      await cleanupTestEnv(projectDir, homeDir);
    });

    it(`deploys to correct project directories`, async () => {
      runDeploy(config.name, projectDir, homeDir);

      for (const expectedPath of config.projectPaths) {
        const fullPath = path.join(projectDir, expectedPath);
        const exists = await pathExists(fullPath);
        expect(exists, `Expected ${expectedPath} to exist`).toBe(true);
      }
    });

    if (config.homePaths && config.homePaths.length > 0) {
      it(`deploys to correct home directories`, async () => {
        runDeploy(config.name, projectDir, homeDir);

        for (const expectedPath of config.homePaths!) {
          const resolvedPath = expectedPath.replace('~/', '');
          const fullPath = path.join(homeDir, resolvedPath);
          const exists = await pathExists(fullPath);
          expect(exists, `Expected ${expectedPath} to exist in home dir`).toBe(true);
        }
      });
    }

    if (config.rootFiles && config.rootFiles.length > 0) {
      it(`creates correct root files`, async () => {
        runDeploy(config.name, projectDir, homeDir);

        for (const rootFile of config.rootFiles!) {
          const fullPath = path.join(projectDir, rootFile);
          const exists = await pathExists(fullPath);
          expect(exists, `Expected ${rootFile} to exist in project root`).toBe(true);
        }
      });
    }

    if (config.forbiddenPaths && config.forbiddenPaths.length > 0) {
      it(`does NOT create forbidden paths`, async () => {
        runDeploy(config.name, projectDir, homeDir);

        for (const forbiddenPath of config.forbiddenPaths!) {
          const fullPath = path.join(projectDir, forbiddenPath);
          const exists = await pathExists(fullPath);
          expect(exists, `${forbiddenPath} should NOT exist for ${providerName}`).toBe(false);
        }
      });
    }

    if (config.minArtifacts > 0) {
      it(`deploys at least ${config.minArtifacts} artifacts`, async () => {
        runDeploy(config.name, projectDir, homeDir);

        let totalArtifacts = 0;

        for (const projectPath of config.projectPaths) {
          const fullPath = path.join(projectDir, projectPath);
          const files = await listFilesRecursive(fullPath);
          // Count all artifact files (providers may use mixed extensions)
          const matchingFiles = files.filter(f =>
            f.endsWith('.md') || f.endsWith('.mdc') || f.endsWith('.yaml') || f.endsWith('.json')
          );
          totalArtifacts += matchingFiles.length;
        }

        expect(totalArtifacts).toBeGreaterThanOrEqual(config.minArtifacts);
      });
    }

    it(`does NOT place unexpected files in project root`, async () => {
      runDeploy(config.name, projectDir, homeDir);

      const rootContents = await fs.readdir(projectDir);

      // Filter to only unexpected items
      const expectedRoots = [
        '.git',
        '.aiwg',  // Framework registry always created
        ...(config.projectPaths.map(p => p.split('/')[0])),  // Top-level dirs
        ...(config.rootFiles || []),
      ];

      const unexpected = rootContents.filter(item =>
        !expectedRoots.includes(item) &&
        !item.startsWith('.')  // Allow hidden files like .gitignore
      );

      // Allow certain known files
      const allowedExtras = [
        'CLAUDE.md',  // May be created as context file
        'AGENTS.md',  // May be requested
        'WARP.md',    // Warp aggregated file
        'AIWG.md',    // AIWG hook file
        '.windsurfrules', // Windsurf rules file
        'opencode.json', // opencode: rules wired into instructions[] (#1548)
      ];

      const reallyUnexpected = unexpected.filter(item =>
        !allowedExtras.includes(item)
      );

      expect(reallyUnexpected, `Unexpected files in project root: ${reallyUnexpected.join(', ')}`).toEqual([]);
    });
  });

  describe('Provider Isolation', () => {
    it('each provider creates only its own directories', async () => {
      const providerDirs: Record<string, string[]> = {
        claude: ['.claude'],
        codex: ['.codex', '.agents'],  // .agents/skills/ cross-agent compat (#766)
        factory: ['.factory'],
        copilot: ['.github', '.agents'],   // PUW-012 #1113
        cursor: ['.cursor'],
        opencode: ['.opencode', '.agents'], // PUW-012 #1113
        warp: ['.warp', '.agents'],  // Discrete files + WARP.md aggregated + .agents/skills/ cross-agent compat (#771)
        windsurf: ['.windsurf', '.windsurfrules', '.agents'],  // .agents/skills/ cross-agent compat (#576)
      };

      for (const [provider, expectedDirs] of Object.entries(providerDirs)) {
        const { projectDir, homeDir } = await createTestEnv(`isolation-${provider}`);

        try {
          runDeploy(provider, projectDir, homeDir);

          const rootContents = await fs.readdir(projectDir);
          const createdDirs = rootContents.filter(item =>
            item.startsWith('.') && !['.',  '.git', '.aiwg'].includes(item)
          );

          // Should only have expected provider-specific dirs
          for (const dir of createdDirs) {
            const isExpected = expectedDirs.some(ed => dir === ed);
            expect(isExpected, `${provider} created unexpected directory: ${dir}`).toBe(true);
          }
        } finally {
          await cleanupTestEnv(projectDir, homeDir);
        }
      }
    });
  });

  describe('aiwg use Command Integration', () => {
    // This test uses bin/aiwg.mjs which goes through router-loader → npx tsx
    // Skip if tsx is not available (e.g., in Docker CI containers)
    it.skipIf(!TSX_AVAILABLE)('aiwg use --provider passes provider to all deployments', async () => {
      const { projectDir, homeDir } = await createTestEnv('cli-integration');

      try {
        const env = {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
        };

        // Run aiwg use with provider. This is the only call in this file that
        // goes through the full bin/aiwg.mjs router → tsx cold-compile path
        // (other calls here invoke deploy-agents.mjs directly, or git); under
        // CPU contention from adjacent heavy integration suites (use-all-
        // deployment.test.ts, mixed-addon-deployment.test.ts) on a
        // resource-constrained CI runner, 60s was measured too tight and
        // produced a deterministic spawnSync ETIMEDOUT (3/3 GitHub Actions
        // npm-publish runs for v2026.9.14, never observed on self-hosted
        // Gitea runners).
        execFileSync(
          process.execPath,
          [path.join(REPO_ROOT, 'bin/aiwg.mjs'), 'use', 'sdlc', '--provider', 'codex', '--target', projectDir],
          { timeout: 150_000, cwd: REPO_ROOT, env, encoding: 'utf-8' }
        );

        // Should have .codex directory
        const hasCodex = await pathExists(path.join(projectDir, '.codex'));
        expect(hasCodex, '.codex should exist').toBe(true);

        // Should NOT have .claude directory
        const hasClaude = await pathExists(path.join(projectDir, '.claude'));
        expect(hasClaude, '.claude should NOT exist when using codex provider').toBe(false);

      } finally {
        await cleanupTestEnv(projectDir, homeDir);
      }
    }, 180_000);
  });
});

describe.skipIf(!GIT_INIT_AVAILABLE)('Edge Cases', () => {
  let projectDir: string;
  let homeDir: string;

  beforeEach(async () => {
    const env = await createTestEnv('edge-cases');
    projectDir = env.projectDir;
    homeDir = env.homeDir;
  });

  afterEach(async () => {
    await cleanupTestEnv(projectDir, homeDir);
  });

  it('handles existing directories gracefully', async () => {
    // Pre-create some directories
    await fs.mkdir(path.join(projectDir, '.cursor/rules'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.cursor/rules/existing.mdc'),
      '---\ndescription: existing\n---\nExisting rule'
    );

    // Should not error
    expect(() => {
      runDeploy('cursor', projectDir, homeDir);
    }).not.toThrow();

    // Existing file should still be there
    const exists = await pathExists(path.join(projectDir, '.cursor/rules/existing.mdc'));
    expect(exists).toBe(true);
  });

  it('--dry-run does not create any files', async () => {
    runDeploy('cursor', projectDir, homeDir, ['--dry-run']);

    // Should only have .git and .aiwg (framework registry)
    const contents = await fs.readdir(projectDir);
    const nonGit = contents.filter(c => c !== '.git' && c !== '.aiwg');

    expect(nonGit).toEqual([]);
  });

  it('--force overwrites existing files', async () => {
    // Create a file that will be overwritten (RULES-INDEX.md is always deployed)
    await fs.mkdir(path.join(projectDir, '.claude/rules'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.claude/rules/RULES-INDEX.md'),
      'OLD CONTENT'
    );

    runDeploy('claude', projectDir, homeDir, ['--force']);

    const content = await fs.readFile(
      path.join(projectDir, '.claude/rules/RULES-INDEX.md'),
      'utf-8'
    );

    expect(content).not.toBe('OLD CONTENT');
    expect(content).toContain('# AIWG');  // Should have proper content
  });
});

describe.skipIf(!GIT_INIT_AVAILABLE)('Consolidated Rules Deployment', () => {
  let projectDir: string;
  let homeDir: string;

  beforeEach(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
    const env = await createTestEnv('consolidated-rules');
    projectDir = env.projectDir;
    homeDir = env.homeDir;
  });

  afterEach(async () => {
    await cleanupTestEnv(projectDir, homeDir);
  });

  it('deploys RULES-INDEX.md instead of individual rule files for Claude', async () => {
    runDeploy('claude', projectDir, homeDir);

    const rulesDir = path.join(projectDir, '.claude', 'rules');
    const exists = await pathExists(rulesDir);
    expect(exists, '.claude/rules/ should exist').toBe(true);

    const files = await fs.readdir(rulesDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    // Should have RULES-INDEX.md
    expect(mdFiles).toContain('RULES-INDEX.md');

    // Per PUW-016 (#1117): individual rule files now ship ALONGSIDE
    // RULES-INDEX.md so the @-references in the index resolve. The original
    // assertion that the consolidated index *replaces* individual files no
    // longer holds. We instead assert that the index plus the individual
    // files are both present — the union surface.
    const individualRules = mdFiles.filter(f => f !== 'RULES-INDEX.md');
    const knownIndividualRules = [
      'no-attribution.md', 'token-security.md', 'versioning.md',
      'anti-laziness.md', 'executable-feedback.md', 'failure-mitigation.md',
      'tao-loop.md', 'hitl-gates.md', 'provenance-tracking.md',
    ];
    for (const knownRule of knownIndividualRules) {
      expect(individualRules, `${knownRule} should be deployed individually per PUW-016`).toContain(knownRule);
    }
  });

  it('RULES-INDEX.md content includes expected sections', async () => {
    runDeploy('claude', projectDir, homeDir);

    const indexPath = path.join(projectDir, '.claude', 'rules', 'RULES-INDEX.md');
    const content = await fs.readFile(indexPath, 'utf-8');

    expect(content).toContain('# AIWG Rules Index');
    expect(content).toContain('## Core Rules');
    expect(content).toContain('## SDLC Rules');
    expect(content).toContain('## Quick Reference by Context');
  });

  it('preserves operator pre-existing rule files on redeploy (#1143 default-off cleanup)', async () => {
    // Per #1143 fix: cleanupOldRuleFiles is now opt-in via opts.cleanRules.
    // The default-off mode means addon-after-main deploys no longer wipe
    // the main framework's rules. As a side-effect, operator-placed files
    // also survive (operator must explicitly clean if desired).
    const rulesDir = path.join(projectDir, '.claude', 'rules');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, 'operator-only.md'), 'operator content');

    runDeploy('claude', projectDir, homeDir);

    // Operator file survives.
    const operatorExists = await pathExists(path.join(rulesDir, 'operator-only.md'));
    expect(operatorExists, 'operator file should survive default-off cleanup').toBe(true);

    // RULES-INDEX.md and individual AIWG rules deploy alongside.
    const indexExists = await pathExists(path.join(rulesDir, 'RULES-INDEX.md'));
    expect(indexExists, 'RULES-INDEX.md should be deployed').toBe(true);
    const aiwgRuleExists = await pathExists(path.join(rulesDir, 'no-attribution.md'));
    expect(aiwgRuleExists, 'AIWG rule should deploy alongside index per PUW-016').toBe(true);
  });

  it('preserves non-.md files during cleanup', async () => {
    // Pre-create .mdc file (Cursor-style rule)
    const rulesDir = path.join(projectDir, '.cursor', 'rules');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, 'custom-rule.mdc'), 'cursor mdc rule');
    await fs.writeFile(path.join(rulesDir, 'old-rule.md'), 'old individual rule');

    runDeploy('cursor', projectDir, homeDir);

    // .mdc file should still exist
    const mdcExists = await pathExists(path.join(rulesDir, 'custom-rule.mdc'));
    expect(mdcExists, '.mdc files should not be removed by cleanup').toBe(true);
  });

  it('deploys consolidated rules for all file-copy providers', async () => {
    // Test representative file-copy providers
    const fileCopyProviders = ['claude', 'factory', 'opencode']; // warp delivers rules via WARP.md, not discrete files

    for (const provider of fileCopyProviders) {
      const env = await createTestEnv(`consolidated-${provider}`);
      try {
        runDeploy(provider, env.projectDir, env.homeDir);

        const config = PROVIDERS[provider];
        const rulesPath = config.projectPaths.find(p => p.includes('rule'));
        if (rulesPath) {
          const fullRulesDir = path.join(env.projectDir, rulesPath);
          const exists = await pathExists(fullRulesDir);
          expect(exists, `${provider}: rules dir should exist`).toBe(true);

          const files = await listFilesRecursive(fullRulesDir);
          const indexFiles = files.filter(f => path.basename(f) === 'RULES-INDEX.md');
          expect(indexFiles.length, `${provider}: should have RULES-INDEX.md`).toBeGreaterThanOrEqual(1);
        }
      } finally {
        await cleanupTestEnv(env.projectDir, env.homeDir);
      }
    }
  });

  it('--dry-run does not deploy rules or clean up old files', async () => {
    // Pre-create old-style files
    const rulesDir = path.join(projectDir, '.claude', 'rules');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, 'old-rule.md'), 'old content');

    runDeploy('claude', projectDir, homeDir, ['--dry-run']);

    // Old file should still exist (not cleaned up)
    const oldExists = await pathExists(path.join(rulesDir, 'old-rule.md'));
    expect(oldExists, 'dry-run should not delete old files').toBe(true);

    // RULES-INDEX.md should NOT be deployed
    const indexExists = await pathExists(path.join(rulesDir, 'RULES-INDEX.md'));
    expect(indexExists, 'dry-run should not deploy new files').toBe(false);
  });
});
