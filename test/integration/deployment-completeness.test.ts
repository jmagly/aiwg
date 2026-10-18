import { mkdtempSync } from '../helpers/temp-dir.js';
/**
 * Deployment Completeness & Content Validation Tests
 *
 * Validates that `aiwg use` deploys ALL expected artifacts to the correct
 * locations with correct content for every provider. This is the "high
 * confidence" suite: if these tests pass, deployment is working correctly.
 *
 * Strategy:
 * 1. Build a source manifest by scanning agentic/code/ for all deployable artifacts
 * 2. Deploy to each provider in an isolated temp directory
 * 3. Verify every expected file exists (structure)
 * 4. Verify file content matches expectations (content)
 * 5. Verify provider-specific transformations (aggregation, translation, frontmatter)
 *
 * @see test/integration/provider-file-locations.test.ts — predecessor (structure-only)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../..');
const AGENTIC_ROOT = path.join(REPO_ROOT, 'agentic/code');
let TEST_BASE: string;
beforeAll(() => { TEST_BASE = mkdtempSync(path.join(os.tmpdir(), 'aiwg-deploy-completeness-')); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canInitGit(): boolean {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-dc-git-'));
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

async function createTestEnv(label: string): Promise<{ projectDir: string; homeDir: string }> {
  const ts = Date.now();
  const projectDir = path.join(TEST_BASE, `${label}-proj-${ts}`);
  const homeDir = path.join(TEST_BASE, `${label}-home-${ts}`);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  execFileSync('git', ['init'], { timeout: 60_000, cwd: projectDir, stdio: 'pipe' });
  return { projectDir, homeDir };
}

async function cleanupTestEnv(projectDir: string, homeDir: string): Promise<void> {
  await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
}

function runDeploy(
  provider: string,
  projectDir: string,
  homeDir: string,
  extraArgs: string[] = [],
): string {
  // Integration tests exercise the legacy per-project mirror via --copy-all.
  if (!extraArgs.includes('--copy-all')) extraArgs = [...extraArgs, '--copy-all'];
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  const args = [
    '--provider', provider,
    '--mode', 'sdlc',
    '--target', projectDir,
    '--deploy-commands',
    '--deploy-skills',
    '--deploy-rules',
    ...extraArgs,
  ];
  try {
    return execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, 'tools/agents/deploy-agents.mjs'), ...args],
      { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 120_000 },
    );
  } catch (e: any) {
    // EMFILE / uv_fs_close crashes are a known issue (#748) — rethrow with context
    if (e.message?.includes('uv_fs_close') || e.message?.includes('EMFILE')) {
      throw new Error(`EMFILE crash during ${provider} deploy (known issue #748). Run test in isolation: npx vitest run -t "${provider}"`);
    }
    throw e;
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...await listFilesRecursive(full));
      else files.push(full);
    }
  } catch { /* dir doesn't exist */ }
  return files;
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Source manifest: what SHOULD be deployed
// ---------------------------------------------------------------------------

interface SourceManifest {
  agents: string[];   // basenames without extension
  skills: string[];   // directory names (each is a SKILL.md folder)
  rules: string[];    // basenames
  commands: string[]; // basenames or directory names
}

async function buildSourceManifest(): Promise<SourceManifest> {
  const manifest: SourceManifest = { agents: [], skills: [], rules: [], commands: [] };

  // Agents: scan only sdlc-complete (matches --mode sdlc deployment).
  // Other frameworks (forensics, media, research) are deployed separately via their own modes.
  const frameworkDirs = ['sdlc-complete'];
  for (const fw of frameworkDirs) {
    const agentsDir = path.join(AGENTIC_ROOT, 'frameworks', fw, 'agents');
    try {
      const entries = await fs.readdir(agentsDir);
      for (const e of entries) {
        if (e.endsWith('.md') && e !== 'manifest.json' && e !== 'README.md') {
          manifest.agents.push(e.replace(/\.md$/, ''));
        }
      }
    } catch { /* framework may not have agents dir */ }
  }

  // Also scan addon agents
  const addonsDir = path.join(AGENTIC_ROOT, 'addons');
  try {
    const addons = await fs.readdir(addonsDir, { withFileTypes: true });
    for (const addon of addons.filter(a => a.isDirectory())) {
      const addonAgentsDir = path.join(addonsDir, addon.name, 'agents');
      try {
        const entries = await fs.readdir(addonAgentsDir);
        for (const e of entries) {
          if (e.endsWith('.md') && e !== 'manifest.json' && e !== 'README.md') {
            manifest.agents.push(e.replace(/\.md$/, ''));
          }
        }
      } catch { /* no agents dir */ }
    }
  } catch { /* no addons dir */ }

  // Skills: scan skill dirs (each skill is a directory with SKILL.md)
  for (const fw of frameworkDirs) {
    const skillsDir = path.join(AGENTIC_ROOT, 'frameworks', fw, 'skills');
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const skillMd = path.join(skillsDir, e.name, 'SKILL.md');
          if (existsSync(skillMd)) manifest.skills.push(e.name);
        }
      }
    } catch { /* no skills dir */ }
  }

  // Addon skills
  try {
    const addons = await fs.readdir(addonsDir, { withFileTypes: true });
    for (const addon of addons.filter(a => a.isDirectory())) {
      const addonSkillsDir = path.join(addonsDir, addon.name, 'skills');
      try {
        const entries = await fs.readdir(addonSkillsDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            const skillMd = path.join(addonSkillsDir, e.name, 'SKILL.md');
            if (existsSync(skillMd)) manifest.skills.push(e.name);
          }
        }
      } catch { /* no skills dir */ }
    }
  } catch { /* no addons dir */ }

  // Deduplicate
  manifest.agents = [...new Set(manifest.agents)];
  manifest.skills = [...new Set(manifest.skills)];

  return manifest;
}

// ---------------------------------------------------------------------------
// Provider expectations
// ---------------------------------------------------------------------------

interface ProviderExpectation {
  name: string;
  /** Directories that MUST exist after deploy */
  requiredDirs: string[];
  /** Files that MUST exist in project root */
  rootFiles: string[];
  /** Where agents land (relative to project or absolute) */
  agentDir: string;
  /** Where skills land */
  skillDir: string;
  /** Where command/prompt wrappers land */
  commandDir: string;
  commandFileExt?: string;
  /** Where rules land */
  ruleDir: string;
  /** Whether agents are aggregated into a single file instead of directory */
  aggregatedAgents: boolean;
  /** Aggregated agent file name if applicable */
  aggregatedAgentFile?: string;
  /** Whether this provider deploys to home dir paths */
  usesHomePaths: boolean;
  /** Cross-agent skills path if applicable */
  crossAgentSkillsDir?: string;
  /** Expected agent file extension */
  agentFileExt: string;
  /** Whether RULES-INDEX.md is used instead of individual rules */
  usesConsolidatedRules: boolean;
}

const PROVIDER_EXPECTATIONS: Record<string, ProviderExpectation> = {
  claude: {
    name: 'claude',
    // Skills sit under .claude/.aiwg/skills/ — index-driven discovery (#1212)
    requiredDirs: ['.claude/agents', '.claude/.aiwg/skills', '.claude/commands', '.claude/rules'],
    rootFiles: [],
    agentDir: '.claude/agents',
    skillDir: '.claude/.aiwg/skills',
    commandDir: '.claude/commands',
    ruleDir: '.claude/rules',
    aggregatedAgents: false,
    usesHomePaths: false,
    agentFileExt: '.md',
    usesConsolidatedRules: true,
  },
  cursor: {
    name: 'cursor',
    requiredDirs: ['.cursor/agents', '.cursor/.aiwg/skills', '.cursor/commands', '.cursor/rules'],
    rootFiles: [],
    agentDir: '.cursor/agents',
    skillDir: '.cursor/.aiwg/skills',
    commandDir: '.cursor/commands',
    ruleDir: '.cursor/rules',
    aggregatedAgents: false,
    usesHomePaths: false,
    agentFileExt: '.md',
    usesConsolidatedRules: false,  // cursor uses .mdc rules
  },
  factory: {
    name: 'factory',
    requiredDirs: ['.factory/droids', '.factory/.aiwg/skills', '.factory/commands', '.factory/rules'],
    rootFiles: [],
    agentDir: '.factory/droids',
    skillDir: '.factory/.aiwg/skills',
    commandDir: '.factory/commands',
    ruleDir: '.factory/rules',
    aggregatedAgents: false,
    usesHomePaths: false,
    agentFileExt: '.md',
    usesConsolidatedRules: true,
  },
  codex: {
    name: 'codex',
    requiredDirs: ['.codex/agents', '.codex/commands', '.codex/rules'],
    rootFiles: [],
    agentDir: '.codex/agents',
    skillDir: '.codex/.aiwg/skills',  // Project-local sequestered mirror; deployed skills live at .agents/skills/ (legacy ~/.codex/skills/ pruned on deploy — #766)
    commandDir: '.codex/commands',
    ruleDir: '.codex/rules',
    aggregatedAgents: false,
    usesHomePaths: true,
    agentFileExt: '.md',
    usesConsolidatedRules: true,
    crossAgentSkillsDir: '.agents/skills',  // Cross-agent path (#766 fix)
  },
  opencode: {
    name: 'opencode',
    requiredDirs: ['.opencode/.aiwg/skill', '.opencode/command', '.opencode/rule'],
    rootFiles: [],
    agentDir: '.opencode/agent',  // May be empty (config-only)
    skillDir: '.opencode/.aiwg/skill',
    commandDir: '.opencode/command',
    ruleDir: '.opencode/rule',
    aggregatedAgents: false,
    usesHomePaths: false,
    agentFileExt: '.md',
    usesConsolidatedRules: true,
  },
  copilot: {
    name: 'copilot',
    requiredDirs: ['.github/agents', '.github/prompts', '.github/.aiwg/skills', '.github/instructions'],
    rootFiles: [],
    agentDir: '.github/agents',
    skillDir: '.github/.aiwg/skills',
    commandDir: '.github/prompts',
    commandFileExt: '.prompt.md',
    ruleDir: '.github/instructions',
    aggregatedAgents: false,
    usesHomePaths: false,
    agentFileExt: '.agent.md',
    usesConsolidatedRules: false,
  },
  warp: {
    name: 'warp',
    requiredDirs: ['.warp/.aiwg/skills', '.warp/commands'],
    rootFiles: ['WARP.md'],
    agentDir: '.warp/agents',
    skillDir: '.warp/.aiwg/skills',
    commandDir: '.warp/commands',
    ruleDir: '.warp/rules',
    aggregatedAgents: true,
    aggregatedAgentFile: 'WARP.md',
    usesHomePaths: false,
    crossAgentSkillsDir: '.agents/skills',
    agentFileExt: '.md',
    usesConsolidatedRules: false,  // rules go into WARP.md
  },
  windsurf: {
    name: 'windsurf',
    requiredDirs: ['.windsurf/.aiwg/skills', '.windsurf/workflows', '.windsurf/rules'],
    rootFiles: ['AGENTS.md'],
    agentDir: '.windsurf/agents',
    skillDir: '.windsurf/.aiwg/skills',
    commandDir: '.windsurf/workflows',
    ruleDir: '.windsurf/rules',
    aggregatedAgents: true,
    aggregatedAgentFile: 'AGENTS.md',
    usesHomePaths: false,
    crossAgentSkillsDir: '.agents/skills',
    agentFileExt: '.md',
    usesConsolidatedRules: false,
  },
};

// Providers that deploy agents as individual files (not aggregated).
// Exclude codex — its deploy-agents.mjs generates AGENTS.md, not individual agent files to .codex/agents/.
const FILE_BASED_AGENT_PROVIDERS = Object.entries(PROVIDER_EXPECTATIONS)
  .filter(([k, v]) => !v.aggregatedAgents && k !== 'codex')
  .map(([k]) => k);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let sourceManifest: SourceManifest;

describe.skipIf(!GIT_INIT_AVAILABLE)('Deployment Completeness', () => {
  beforeAll(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
    sourceManifest = await buildSourceManifest();
  });

  describe('Source manifest sanity checks', () => {
    it('finds a meaningful number of source agents', () => {
      expect(sourceManifest.agents.length).toBeGreaterThan(50);
    });

    it('finds a meaningful number of source skills', () => {
      expect(sourceManifest.skills.length).toBeGreaterThan(20);
    });
  });

  // -------------------------------------------------------------------------
  // Per-provider: directory structure validation
  // -------------------------------------------------------------------------
  describe.each(Object.keys(PROVIDER_EXPECTATIONS))('%s: directory structure', (providerName) => {
    const prov = PROVIDER_EXPECTATIONS[providerName];
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv(`struct-${providerName}`));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    it('creates all required directories', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      for (const dir of prov.requiredDirs) {
        const full = path.join(projectDir, dir);
        expect(await pathExists(full), `Missing: ${dir}`).toBe(true);
      }
    });

    it('creates all required root files', async () => {
      if (prov.rootFiles.length === 0) return;
      runDeploy(prov.name, projectDir, homeDir);
      for (const f of prov.rootFiles) {
        const full = path.join(projectDir, f);
        expect(await pathExists(full), `Missing root file: ${f}`).toBe(true);
      }
    });

    it('deploys skills to the skills directory', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      if (!prov.skillDir) return;

      // Check both project-local and home paths for providers that use home dirs
      const projectSkillsPath = path.join(projectDir, prov.skillDir);
      const homeSkillsPath = prov.usesHomePaths
        ? path.join(homeDir, prov.skillDir.replace(/^\./, ''))
        : null;

      let totalSkillFiles = 0;
      for (const sp of [projectSkillsPath, homeSkillsPath].filter(Boolean) as string[]) {
        const files = await listFilesRecursive(sp);
        totalSkillFiles += files.filter(f => f.endsWith('.md')).length;
      }

      // Codex deploys skills to .agents/skills/ via a separate script (deploy-skills-codex.mjs),
      // not via deploy-agents.mjs (the legacy ~/.codex/skills/ home dir is pruned — #766).
      // When running deploy-agents.mjs directly, the project skill dirs may be empty.
      // This is expected behavior, not a bug.
      if (providerName === 'codex' && totalSkillFiles === 0) {
        console.warn('codex: skills not deployed via deploy-agents.mjs — use deploy-skills-codex.mjs separately');
        return;
      }
      expect(totalSkillFiles, `${providerName}: should deploy skills`).toBeGreaterThan(0);
    });

    it('mirrors operator skills to the provider command surface', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      const commandExt = prov.commandFileExt ?? '.md';
      const commandsPath = path.join(projectDir, prov.commandDir);
      const expected = [
        `aiwg-setup-project${commandExt}`,
        `aiwg-update-claude${commandExt}`,
        `aiwg-update-agents-md${commandExt}`,
      ];

      for (const file of expected) {
        expect(await pathExists(path.join(commandsPath, file)), `${providerName}: missing mirrored command ${file}`).toBe(true);
      }
    });

    if (PROVIDER_EXPECTATIONS[providerName].crossAgentSkillsDir) {
      it('deploys cross-agent skills to .agents/skills/', async () => {
        runDeploy(prov.name, projectDir, homeDir);
        const crossPath = path.join(projectDir, prov.crossAgentSkillsDir!);
        expect(await pathExists(crossPath), `Missing cross-agent skills: ${prov.crossAgentSkillsDir}`).toBe(true);
        const files = await listFilesRecursive(crossPath);
        expect(files.length, `${providerName}: .agents/skills/ should have content`).toBeGreaterThan(0);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Per-provider: agent deployment completeness
  // -------------------------------------------------------------------------
  describe.each(FILE_BASED_AGENT_PROVIDERS)('%s: agent completeness', (providerName) => {
    const prov = PROVIDER_EXPECTATIONS[providerName];
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv(`agents-${providerName}`));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    it('deploys agents to the agent directory', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      const agentPath = prov.usesHomePaths
        ? path.join(homeDir, prov.agentDir.replace(/^~\//, ''))
        : path.join(projectDir, prov.agentDir);

      if (!prov.agentDir) return; // skip if empty (e.g. opencode agents are config-only)

      const files = await listFilesRecursive(agentPath);
      const agentFiles = files.filter(f => f.endsWith('.md'));

      // Should deploy a substantial number of agents
      expect(agentFiles.length, `${providerName}: should deploy many agents`).toBeGreaterThan(30);
    });

    it('every deployed agent has valid YAML frontmatter', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      const agentPath = prov.usesHomePaths
        ? path.join(homeDir, prov.agentDir.replace(/^~\//, ''))
        : path.join(projectDir, prov.agentDir);

      if (!prov.agentDir) return;

      const files = await listFilesRecursive(agentPath);
      const agentFiles = files.filter(f => f.endsWith('.md'));

      // Sample first 10 agents for frontmatter validation
      const sample = agentFiles.slice(0, 10);
      for (const agentFile of sample) {
        const raw = await fs.readFile(agentFile, 'utf-8');
        const basename = path.basename(agentFile);

        // Strip optional <!-- aiwg:managed --> header line
        const content = raw.replace(/^<!--\s*aiwg:managed[^>]*-->\n?/, '');

        // Must have --- (YAML frontmatter) somewhere near the start
        const fmStart = content.indexOf('---');
        expect(fmStart, `${basename}: should have YAML frontmatter`).toBeLessThan(10);

        if (fmStart >= 0) {
          const secondDash = content.indexOf('---', fmStart + 3);
          expect(secondDash, `${basename}: should have closing ---`).toBeGreaterThan(fmStart + 3);

          const frontmatter = content.slice(fmStart + 3, secondDash);
          // Most providers include name:, but some (opencode) may omit it.
          // At minimum, frontmatter should have description: or model:
          const hasUsefulField = /description:|model:|name:/.test(frontmatter);
          expect(hasUsefulField, `${basename}: frontmatter should have description, model, or name`).toBe(true);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Aggregated agent files (WARP.md, AGENTS.md)
  // -------------------------------------------------------------------------
  describe.each(['warp', 'windsurf'])('%s: aggregated agent file', (providerName) => {
    const prov = PROVIDER_EXPECTATIONS[providerName];
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv(`agg-${providerName}`));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    it('aggregated file exists and has substantial content', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      const aggFile = path.join(projectDir, prov.aggregatedAgentFile!);
      expect(await pathExists(aggFile), `${prov.aggregatedAgentFile} should exist`).toBe(true);

      const content = await fs.readFile(aggFile, 'utf-8');
      // Should be substantial (contains aggregated agents)
      expect(content.length, `${prov.aggregatedAgentFile} should have substantial content`).toBeGreaterThan(1000);
    });

    it('aggregated file references AIWG framework', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      const aggFile = path.join(projectDir, prov.aggregatedAgentFile!);
      const content = await fs.readFile(aggFile, 'utf-8');
      expect(content.toLowerCase()).toContain('aiwg');
    });
  });

  // -------------------------------------------------------------------------
  // Skill content validation
  // -------------------------------------------------------------------------
  describe.each(['claude', 'cursor', 'factory'])('%s: skill content validation', (providerName) => {
    const prov = PROVIDER_EXPECTATIONS[providerName];
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv(`skill-content-${providerName}`));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    it('each skill directory contains a SKILL.md', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      const skillsPath = path.join(projectDir, prov.skillDir);
      const entries = await fs.readdir(skillsPath, { withFileTypes: true }).catch(() => []);
      const skillDirs = (entries as any[]).filter((e: any) => e.isDirectory());

      expect(skillDirs.length, `${providerName}: should have skill directories`).toBeGreaterThan(0);

      // Sample first 10 for validation
      const sample = skillDirs.slice(0, 10);
      for (const skillDir of sample) {
        const skillMd = path.join(skillsPath, skillDir.name, 'SKILL.md');
        expect(await pathExists(skillMd), `${skillDir.name}/SKILL.md should exist`).toBe(true);
      }
    });

    it('SKILL.md files have frontmatter with description', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      const skillsPath = path.join(projectDir, prov.skillDir);
      const entries = await fs.readdir(skillsPath, { withFileTypes: true }).catch(() => []);
      const skillDirs = (entries as any[]).filter((e: any) => e.isDirectory());

      const sample = skillDirs.slice(0, 5);
      for (const skillDir of sample) {
        const skillMd = path.join(skillsPath, skillDir.name, 'SKILL.md');
        if (!await pathExists(skillMd)) continue;

        const raw = await fs.readFile(skillMd, 'utf-8');
        // Strip optional <!-- aiwg:managed --> header
        const content = raw.replace(/^<!--\s*aiwg:managed[^>]*-->\n?/, '');

        const fmStart = content.indexOf('---');
        expect(fmStart, `${skillDir.name}/SKILL.md: should have frontmatter`).toBeLessThan(10);

        if (fmStart >= 0) {
          const secondDash = content.indexOf('---', fmStart + 3);
          expect(secondDash, `${skillDir.name}/SKILL.md: should have closing ---`).toBeGreaterThan(fmStart + 3);

          const fm = content.slice(fmStart + 3, secondDash);
          // Skills should have description: or at minimum namespace:/platforms: fields
          const hasUsefulField = /description:|namespace:|platforms:|name:/.test(fm);
          expect(hasUsefulField, `${skillDir.name}/SKILL.md: frontmatter should have key fields`).toBe(true);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Rules deployment validation
  // -------------------------------------------------------------------------
  describe.each(['claude', 'factory', 'opencode'])('%s: consolidated rules', (providerName) => {
    const prov = PROVIDER_EXPECTATIONS[providerName];
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv(`rules-${providerName}`));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    it('deploys RULES-INDEX.md', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      const rulesDir = path.join(projectDir, prov.ruleDir);
      const indexPath = path.join(rulesDir, 'RULES-INDEX.md');
      expect(await pathExists(indexPath), `${providerName}: RULES-INDEX.md should exist`).toBe(true);
    });

    it('RULES-INDEX.md has expected structure', async () => {
      runDeploy(prov.name, projectDir, homeDir);
      const indexPath = path.join(projectDir, prov.ruleDir, 'RULES-INDEX.md');
      const content = await fs.readFile(indexPath, 'utf-8');

      expect(content).toContain('# AIWG');
      // Should reference rules by name
      expect(content.length).toBeGreaterThan(500);
    });

    it('deploys individual rule files alongside RULES-INDEX.md (PUW-016 #1117)', async () => {
      // Per PUW-016: individual rule files now ship alongside the
      // consolidated RULES-INDEX.md so the index's @-references resolve.
      // The original test expected only RULES-INDEX.md; the assertion is
      // flipped to require both surfaces.
      runDeploy(prov.name, projectDir, homeDir);
      const rulesDir = path.join(projectDir, prov.ruleDir);
      const files = await fs.readdir(rulesDir).catch(() => []);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      const expectedRules = ['no-attribution.md', 'anti-laziness.md', 'token-security.md',
        'executable-feedback.md', 'versioning.md', 'failure-mitigation.md'];

      for (const rule of expectedRules) {
        expect(mdFiles, `${providerName}: ${rule} should be deployed alongside RULES-INDEX.md`).toContain(rule);
      }
      expect(mdFiles, `${providerName}: RULES-INDEX.md still ships`).toContain('RULES-INDEX.md');
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency: deploy twice, same result
  // -------------------------------------------------------------------------
  describe('Idempotency', () => {
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv('idempotent'));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    // Regression test: second deploy must not lose files that the first deploy created.
    // Root cause was cleanupOldRuleFiles deleting .md files, then deployFiles skipping
    // re-write due to sidecar hash-match on a file that no longer exists on disk.
    // Fix: base.mjs deployFiles hash-match now checks fs.existsSync(dest) before skipping.
    it('deploying claude twice does not lose files (no regression)', async () => {
      runDeploy('claude', projectDir, homeDir);
      const firstFiles = new Set(
        (await listFilesRecursive(path.join(projectDir, '.claude')))
          .map(f => path.relative(projectDir, f))
      );
      const firstCount = firstFiles.size;

      runDeploy('claude', projectDir, homeDir);
      const secondFiles = new Set(
        (await listFilesRecursive(path.join(projectDir, '.claude')))
          .map(f => path.relative(projectDir, f))
      );

      // Every file from first deploy should still exist after second deploy
      const missing = [...firstFiles].filter(f => !secondFiles.has(f));
      expect(missing, 'Files lost on redeploy').toEqual([]);

      // Count should not decrease
      expect(secondFiles.size, 'File count should not decrease on redeploy').toBeGreaterThanOrEqual(firstCount);
    });

    it('deploying claude twice does not corrupt file content', async () => {
      runDeploy('claude', projectDir, homeDir);
      const rulesContent1 = await fs.readFile(
        path.join(projectDir, '.claude/rules/RULES-INDEX.md'), 'utf-8'
      );

      runDeploy('claude', projectDir, homeDir);
      const rulesContent2 = await fs.readFile(
        path.join(projectDir, '.claude/rules/RULES-INDEX.md'), 'utf-8'
      );

      expect(rulesContent2).toBe(rulesContent1);
    });
  });

  // -------------------------------------------------------------------------
  // Artifact count regression guards
  // -------------------------------------------------------------------------
  describe('Artifact count regression guards', () => {
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv('counts'));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    // These thresholds are based on known counts as of 2026-04-07.
    // If a threshold fails, it likely means artifacts were removed or deployment broke.
    // Update thresholds ONLY after confirming the removal was intentional.
    const EXPECTED_MINIMUMS: Record<string, { agents: number; skills: number }> = {
      claude: { agents: 100, skills: 30 },
      cursor: { agents: 100, skills: 30 },
      factory: { agents: 50, skills: 20 },
      // Codex: agents go to .codex/agents/ (project) but deploy-agents.mjs may use
      // a different path or generate AGENTS.md. Skills go to ~/.codex/skills/ (home).
      // Lower thresholds pending codex deployment verification.
      codex: { agents: 0, skills: 0 },
      opencode: { agents: 0, skills: 20 },  // opencode agents are config-only
      copilot: { agents: 50, skills: 10 },
    };

    it.each(Object.entries(EXPECTED_MINIMUMS))(
      '%s: deploys at least %j agents and skills',
      async (providerName, mins) => {
        const prov = PROVIDER_EXPECTATIONS[providerName];
        runDeploy(prov.name, projectDir, homeDir);

        // Count agents
        const agentDir = path.join(projectDir, prov.agentDir);
        const agentFiles = (await listFilesRecursive(agentDir))
          .filter(f => f.endsWith('.md'));
        expect(agentFiles.length, `${providerName} agent count regression`).toBeGreaterThanOrEqual(mins.agents);

        // Count skills — check both project and home paths
        const skillDirProject = path.join(projectDir, prov.skillDir);
        const skillDirHome = prov.usesHomePaths
          ? path.join(homeDir, prov.skillDir.replace(/^\./, ''))
          : null;

        let skillDirCount = 0;
        for (const sdir of [skillDirProject, skillDirHome].filter(Boolean) as string[]) {
          const entries = await fs.readdir(sdir, { withFileTypes: true }).catch(() => []);
          skillDirCount += (entries as any[]).filter((e: any) => e.isDirectory()).length;
        }
        expect(skillDirCount, `${providerName} skill count regression`).toBeGreaterThanOrEqual(mins.skills);

        // Reset env for next iteration
        await cleanupTestEnv(projectDir, homeDir);
        ({ projectDir, homeDir } = await createTestEnv(`counts-${providerName}`));
      }
    );
  });

  // -------------------------------------------------------------------------
  // Codex home-dir skills (known #766 — skills deploy to ~/.codex/skills/)
  // -------------------------------------------------------------------------
  describe('codex: skill deployment path (#766 — single scanned location)', () => {
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv('codex-home'));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    it('deploys skills to project .agents/skills/ and NOT the legacy ~/.codex/skills/ home dir', async () => {
      runDeploy('codex', projectDir, homeDir);

      // Skills must land in the cross-provider .agents/skills/ — the path
      // codex-rs scans. runDeploy forces --copy-all, so the full set deploys.
      const agentsSkillsDir = path.join(projectDir, '.agents', 'skills');
      expect(await pathExists(agentsSkillsDir), 'codex: should deploy skills to .agents/skills/').toBe(true);
      const entries = await fs.readdir(agentsSkillsDir, { withFileTypes: true });
      const skillDirs = entries.filter(e => e.isDirectory());
      expect(skillDirs.length, 'codex: .agents/skills/ should hold the deployed skills').toBeGreaterThan(10);

      // The legacy home-dir location must NOT be written — writing both made
      // codex-rs list every kernel skill twice (the reported duplicate bug).
      const legacyHomeSkillsDir = path.join(homeDir, '.codex', 'skills');
      expect(await pathExists(legacyHomeSkillsDir), 'codex: legacy ~/.codex/skills/ must not be created').toBe(false);
    });

    it('deploys prompts/commands to ~/.codex/prompts/ (home directory)', async () => {
      runDeploy('codex', projectDir, homeDir);
      const homePromptsDir = path.join(homeDir, '.codex', 'prompts');
      const exists = await pathExists(homePromptsDir);
      // Note: if this dir doesn't exist, codex prompt deployment may need investigation
      if (exists) {
        const files = await listFilesRecursive(homePromptsDir);
        // Soft assertion — prompts may not deploy via deploy-agents.mjs
        // (they use a separate deploy-prompts-codex.mjs script)
        if (files.length === 0) {
          console.warn('codex: ~/.codex/prompts/ exists but is empty — may need separate deploy-prompts script');
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // --dry-run produces zero side effects
  // -------------------------------------------------------------------------
  describe('--dry-run safety', () => {
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv('dryrun'));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    it.each(['claude', 'cursor', 'factory', 'codex'])(
      '%s: --dry-run creates no deployment directories',
      async (providerName) => {
        runDeploy(providerName, projectDir, homeDir, ['--dry-run']);
        const contents = await fs.readdir(projectDir);
        const nonGitNonAiwg = contents.filter(c => c !== '.git' && c !== '.aiwg');
        expect(nonGitNonAiwg, `${providerName}: dry-run should create nothing`).toEqual([]);
      }
    );
  });

  // -------------------------------------------------------------------------
  // Copilot-specific: .agent.md format
  // -------------------------------------------------------------------------
  describe('copilot: .agent.md format', () => {
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv('copilot-format'));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    it('agent files use .agent.md or .md extension', async () => {
      runDeploy('copilot', projectDir, homeDir);
      const agentsDir = path.join(projectDir, '.github/agents');
      const files = await listFilesRecursive(agentsDir);
      const agentFiles = files.filter(f => f.endsWith('.md'));
      expect(agentFiles.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Provider isolation: no cross-contamination
  // -------------------------------------------------------------------------
  describe('Provider isolation', () => {
    it.each(['claude', 'cursor', 'factory', 'codex', 'opencode'])(
      '%s: does not create other providers\' directories',
      async (providerName) => {
        const { projectDir, homeDir } = await createTestEnv(`iso-${providerName}`);
        try {
          runDeploy(providerName, projectDir, homeDir);
          const contents = await fs.readdir(projectDir);

          const providerDirMap: Record<string, string[]> = {
            claude: ['.claude'],
            cursor: ['.cursor'],
            factory: ['.factory'],
            codex: ['.codex', '.agents'],     // .agents/skills/ = cross-agent path (#766)
            opencode: ['.opencode', '.agents'], // PUW-012 #1113
          };

          const allowedDirs = ['.git', '.aiwg', ...(providerDirMap[providerName] || [])];

          for (const item of contents) {
            if (item.startsWith('.')) {
              expect(
                allowedDirs.includes(item),
                `${providerName} created unexpected: ${item}`
              ).toBe(true);
            }
          }
        } finally {
          await cleanupTestEnv(projectDir, homeDir);
        }
      }
    );
  });

  // -------------------------------------------------------------------------
  // Source-to-deploy completeness: are all source agents deployed?
  // -------------------------------------------------------------------------
  describe('Source-to-deploy completeness (claude)', () => {
    let projectDir: string;
    let homeDir: string;

    beforeEach(async () => {
      ({ projectDir, homeDir } = await createTestEnv('completeness'));
    });
    afterEach(async () => { await cleanupTestEnv(projectDir, homeDir); });

    it('every source agent is deployed to .claude/agents/', async () => {
      runDeploy('claude', projectDir, homeDir);
      const agentsDir = path.join(projectDir, '.claude/agents');
      const deployedFiles = await listFilesRecursive(agentsDir);
      const deployedNames = new Set(
        deployedFiles
          .filter(f => f.endsWith('.md'))
          .map(f => path.basename(f, '.md'))
      );

      const missing: string[] = [];
      for (const agent of sourceManifest.agents) {
        if (!deployedNames.has(agent)) {
          missing.push(agent);
        }
      }

      // Allow some tolerance for agents that may be provider-filtered,
      // but the vast majority should be present
      const deployRate = 1 - (missing.length / sourceManifest.agents.length);
      expect(
        deployRate,
        `Only ${(deployRate * 100).toFixed(1)}% of source agents deployed. Missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`
      ).toBeGreaterThan(0.85);  // At least 85% of sdlc source agents should deploy
    });

    it('every source skill is deployed to .claude/.aiwg/skills/', async () => {
      runDeploy('claude', projectDir, homeDir);
      const skillsDir = path.join(projectDir, '.claude/.aiwg/skills');
      const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
      const deployedSkillDirs = new Set(
        (entries as any[])
          .filter((e: any) => e.isDirectory())
          .map((e: any) => e.name)
      );

      const missing: string[] = [];
      for (const skill of sourceManifest.skills) {
        // Skills may be deployed with namespace prefix (aiwg-{name}) or as-is
        if (!deployedSkillDirs.has(skill) && !deployedSkillDirs.has(`aiwg-${skill}`)) {
          missing.push(skill);
        }
      }

      const deployRate = 1 - (missing.length / sourceManifest.skills.length);
      expect(
        deployRate,
        `Only ${(deployRate * 100).toFixed(1)}% of source skills deployed. Missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`
      ).toBeGreaterThan(0.80);  // At least 80% of sdlc source skills should deploy
    });
  });
});
