// Share isolated filesystem fixtures for provider location integration checks.
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { mkdtempSync } from './temp-dir.js';
const REPO_ROOT = path.resolve(__dirname, '../..');

interface ProviderConfig {
  name: string;
  projectPaths: string[];       // Paths that should exist in project dir
  homePaths?: string[];         // Paths that should exist in home dir
  rootFiles?: string[];         // Files that should exist in project root
  forbiddenPaths?: string[];    // Paths that should NOT exist
  fileExtension: string;        // Expected file extension for artifacts
  minArtifacts?: number;        // Minimum number of artifacts expected
}

export const PROVIDERS: Record<string, ProviderConfig> = {
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
export async function createTestEnv(provider: string): Promise<{ projectDir: string; homeDir: string }> {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), `aiwg-${provider}-project-`));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), `aiwg-${provider}-home-`));

  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });

  // Initialize git (some providers require it)
  execFileSync('git', ['init'], { timeout: 60_000, cwd: projectDir, stdio: 'pipe' });

  return { projectDir, homeDir };
}

// Helper to clean up test directory
export async function cleanupTestEnv(projectDir: string, homeDir: string): Promise<void> {
  if (projectDir) {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
  if (homeDir) {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

// Helper to run deployment
export function runDeploy(
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
export async function listFilesRecursive(dir: string): Promise<string[]> {
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
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

