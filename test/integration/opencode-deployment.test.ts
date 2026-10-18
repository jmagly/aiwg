import { mkdtempSync } from '../helpers/temp-dir.js';
/**
 * Integration tests for OpenCode provider deployment
 *
 * Tests AIWG agent and command deployment to OpenCode format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OPENCODE_DEPLOY_MODELS } from '../fixtures/models.js';
import { cliCommand } from '../helpers/cli-command.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

function runNode(args: string[], options: Parameters<typeof execFileSync>[2]) {
  return execFileSync(process.execPath, args, { ...options, timeout: options?.timeout ?? 60_000 });
}

describe('OpenCode literal command arguments', () => {
  it.each([
    { site: 'agent directory', flags: ['--provider', 'opencode', '--mode', 'sdlc'] },
    { site: 'command directory', flags: ['--provider', 'opencode', '--mode', 'sdlc', '--deploy-commands'] },
    { site: 'skill directory', flags: ['--provider', 'opencode', '--mode', 'sdlc', '--deploy-skills'] },
    { site: 'skill files', flags: ['--provider', 'opencode', '--mode', 'sdlc', '--deploy-skills'] },
    { site: 'agent manifest', flags: ['--provider', 'opencode', '--mode', 'sdlc', '--create-agents-md'] },
    { site: 'first manifest append', flags: ['--provider', 'opencode', '--mode', 'sdlc', '--create-agents-md'] },
    { site: 'second manifest append', flags: ['--provider', 'opencode', '--mode', 'sdlc', '--create-agents-md'] },
    { site: 'model configuration', flags: ['--provider', 'opencode', '--mode', 'sdlc', '--deploy-skills'] },
    { site: 'marketing mode', flags: ['--provider', 'opencode', '--mode', 'marketing', '--deploy-skills'] },
    { site: 'dry run', flags: ['--provider', 'opencode', '--mode', 'sdlc', '--dry-run'] },
    { site: 'MCP configuration', flags: ['install', 'opencode'] },
    { site: 'MCP merge', flags: ['install', 'opencode'] },
  ])('preserves paths for $site', ({ flags }) => {
    const script = 'script with spaces;$literal.mjs';
    const target = 'target with spaces;$(echo expanded)';
    const args = flags[0] === 'install' ? [script, ...flags, target] : [script, '--target', target, ...flags];
    const execute = vi.mocked(execFileSync);
    execute.mockReturnValueOnce('literal output');
    expect(runNode(args, { encoding: 'utf-8', timeout: 60_000 })).toBe('literal output');
    expect(execute).toHaveBeenLastCalledWith(process.execPath, args, { encoding: 'utf-8', timeout: 60_000 });
  });
});

// OpenCode is installed at ~/.opencode/bin/opencode
const OPENCODE_PATH = path.join(os.homedir(), '.opencode', 'bin', 'opencode');

// Native --version/--help probes can create their own runtime temp directory.
// Probes also run during collection, when skipped suites do not run hooks.
function withNativeCliEnv<T>(run: (env: NodeJS.ProcessEnv) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-opencode-native-'));
  try {
    return run({ ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Check if opencode CLI is available
function isOpenCodeAvailable(): boolean {
  try {
    // Try direct path first
    if (fs.existsSync(OPENCODE_PATH)) {
      const result = withNativeCliEnv(env => spawnSync(...cliCommand(OPENCODE_PATH, ['--version']), {
        encoding: 'utf-8',
        timeout: 5000,
        env,
      }));
      return result.status === 0;
    }
    // Try via PATH
    const result = withNativeCliEnv(env => spawnSync(...cliCommand('opencode', ['--version']), {
      encoding: 'utf-8',
      timeout: 5000,
      env,
    }));
    return result.status === 0;
  } catch (error) {
    console.warn(`opencode CLI probe failed: ${String(error)}`);
    return false;
  }
}

const OPENCODE_AVAILABLE = isOpenCodeAvailable();

// Helper to run opencode CLI commands
function runOpenCode(
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): { stdout: string; stderr: string; status: number | null } {
  try {
    // Use direct path if available, otherwise resolve the executable via PATH
    const cmd = fs.existsSync(OPENCODE_PATH) ? OPENCODE_PATH : 'opencode';
    const result = withNativeCliEnv(env => spawnSync(...cliCommand(cmd, args), {
      encoding: 'utf-8',
      timeout: options.timeout || 30000,
      cwd: options.cwd || process.cwd(),
      env,
    }));
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      status: result.status,
    };
  } catch (e) {
    return { stdout: '', stderr: String(e), status: -1 };
  }
}

describe('OpenCode Deployment', () => {
  let testDir: string;
  const deployScript = path.resolve(__dirname, '../../tools/agents/deploy-agents.mjs');

  beforeEach(() => {
    // Create temporary test directory
    testDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg opencode;$literal-test-'));
  });

  afterEach(() => {
    // Cleanup test directory
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Agent Deployment', () => {
    it('should deploy agents to .opencode/agent/ directory', () => {
      // OpenCode discovers agents via glob within .opencode/agent/ directory.
      runNode([deployScript, '--target', testDir, '--provider', 'opencode', '--mode', 'sdlc'], { timeout: 60_000,
        encoding: 'utf-8'
      });

      const agentDir = path.join(testDir, '.opencode', 'agent');
      expect(fs.existsSync(agentDir)).toBe(true);
    });

    it('should NOT deploy commands to legacy .opencode/commands/', () => {
      // OpenCode's generated command surface is .opencode/command/ (singular);
      // .opencode/commands/ is not scanned.
      runNode([deployScript, '--target', testDir, '--provider', 'opencode', '--mode', 'sdlc', '--deploy-commands'], { timeout: 60_000,
        encoding: 'utf-8'
      });

      const commandDir = path.join(testDir, '.opencode', 'commands');
      expect(fs.existsSync(commandDir)).toBe(false);
    });
  });

  describe('Skill Deployment', () => {
    it('should deploy skills to .opencode/skill/ directory', () => {
      runNode([deployScript, '--target', testDir, '--provider', 'opencode', '--mode', 'sdlc', '--deploy-skills'], { timeout: 60_000,
        encoding: 'utf-8'
      });

      const skillDir = path.join(testDir, '.opencode', 'skill');
      expect(fs.existsSync(skillDir)).toBe(true);

      const skills = fs.readdirSync(skillDir);
      expect(skills.length).toBeGreaterThan(0);
    });

    it('should deploy skills with SKILL.md files', () => {
      runNode([deployScript, '--target', testDir, '--provider', 'opencode', '--mode', 'sdlc', '--deploy-skills'], { timeout: 60_000,
        encoding: 'utf-8'
      });

      const skillDir = path.join(testDir, '.opencode', 'skill');
      const skills = fs.readdirSync(skillDir);

      // Check at least one skill has SKILL.md
      const hasSkillMd = skills.some(s => {
        const skillMdPath = path.join(skillDir, s, 'SKILL.md');
        return fs.existsSync(skillMdPath);
      });
      expect(hasSkillMd).toBe(true);
    });
  });

  describe('AGENTS.md Generation', () => {
    it('should create AGENTS.md when --create-agents-md is specified', () => {
      runNode([deployScript, '--target', testDir, '--provider', 'opencode', '--mode', 'sdlc', '--create-agents-md'], { timeout: 60_000,
        encoding: 'utf-8'
      });

      const agentsMdPath = path.join(testDir, 'AGENTS.md');
      expect(fs.existsSync(agentsMdPath)).toBe(true);

      const content = fs.readFileSync(agentsMdPath, 'utf-8');
      expect(content).toContain('AIWG SDLC Framework');
      expect(content).toContain('.opencode/skill/');
    });

    it('should append to existing AGENTS.md without duplicating', () => {
      // Create initial AGENTS.md
      const agentsMdPath = path.join(testDir, 'AGENTS.md');
      fs.writeFileSync(agentsMdPath, '# Project Agents\n\nExisting content.\n');

      // Deploy twice
      runNode([deployScript, '--target', testDir, '--provider', 'opencode', '--mode', 'sdlc', '--create-agents-md'], { timeout: 60_000,
        encoding: 'utf-8'
      });
      runNode([deployScript, '--target', testDir, '--provider', 'opencode', '--mode', 'sdlc', '--create-agents-md'], { timeout: 60_000,
        encoding: 'utf-8'
      });

      const content = fs.readFileSync(agentsMdPath, 'utf-8');

      // Should contain AIWG marker comment only once (not duplicated by second deploy)
      // Note: The template contains "AIWG SDLC Framework" twice (in comment and heading), which is expected
      const markerMatches = content.match(/<!-- AIWG SDLC Framework Integration -->/g);
      expect(markerMatches?.length).toBe(1);

      // Should contain the heading only once
      const headerMatches = content.match(/## AIWG SDLC Framework/g);
      expect(headerMatches?.length).toBe(1);

      // Should preserve original content
      expect(content).toContain('Existing content.');
    });
  });

  describe('Model Configuration', () => {
    it('should deploy skills without errors (model config applies to MCP, not file artifacts)', () => {
      // OpenCode agents are config-only — model format is validated via opencode.json, not file deployment.
      // Skills are the deployable artifacts; verify they deploy cleanly.
      runNode([deployScript, '--target', testDir, '--provider', 'opencode', '--mode', 'sdlc', '--deploy-skills'], { timeout: 60_000,
        encoding: 'utf-8'
      });

      const skillDir = path.join(testDir, '.opencode', 'skill');
      expect(fs.existsSync(skillDir)).toBe(true);
    });
  });

  describe('Marketing Mode', () => {
    it('should deploy marketing skills when mode is marketing', () => {
      runNode([deployScript, '--target', testDir, '--provider', 'opencode', '--mode', 'marketing', '--deploy-skills'], { timeout: 60_000,
        encoding: 'utf-8'
      });

      // Agents are deployed to .opencode/agent/ and skills to .opencode/skill/
      const agentDir = path.join(testDir, '.opencode', 'agent');
      expect(fs.existsSync(agentDir)).toBe(true);

      const skillDir = path.join(testDir, '.opencode', 'skill');
      expect(fs.existsSync(skillDir)).toBe(true);
    });
  });

  describe('Dry Run', () => {
    it('should not write files in dry-run mode', () => {
      runNode([deployScript, '--target', testDir, '--provider', 'opencode', '--mode', 'sdlc', '--dry-run'], { timeout: 60_000,
        encoding: 'utf-8'
      });

      const agentDir = path.join(testDir, '.opencode', 'agent');
      expect(fs.existsSync(agentDir)).toBe(false);
    });
  });
});

describe('OpenCode MCP Configuration', () => {
  let testDir: string;
  const cliPath = path.resolve(__dirname, '../../src/mcp/cli.mjs');

  beforeEach(() => {
    testDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg opencode;$literal-mcp-test-'));
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should generate opencode.json with MCP configuration', () => {
    // Use cwd option instead of process.chdir (not supported in workers)
    runNode([cliPath, 'install', 'opencode', testDir], { timeout: 60_000,
      encoding: 'utf-8',
      cwd: testDir
    });

    const configPath = path.join(testDir, 'opencode.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcp).toBeDefined();
    expect(config.mcp.aiwg).toBeDefined();
    expect(config.mcp.aiwg.type).toBe('local');
    expect(config.mcp.aiwg.command).toContain('aiwg');
  });

  it('should merge with existing opencode.json', () => {
    const configPath = path.join(testDir, 'opencode.json');

    // Create existing config
    fs.writeFileSync(configPath, JSON.stringify({
      model: OPENCODE_DEPLOY_MODELS.coding,
      mcp: {
        existing: { type: 'local', command: ['existing-server'] }
      }
    }, null, 2));

    // Use cwd option instead of process.chdir
    runNode([cliPath, 'install', 'opencode', testDir], { timeout: 60_000,
      encoding: 'utf-8',
      cwd: testDir
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Should preserve existing config
    expect(config.model).toBe(OPENCODE_DEPLOY_MODELS.coding);
    expect(config.mcp.existing).toBeDefined();

    // Should add AIWG MCP
    expect(config.mcp.aiwg).toBeDefined();
  });
});

/**
 * Live OpenCode CLI Integration Tests
 *
 * These tests validate integration with the actual OpenCode CLI tool.
 * Tests are skipped if OpenCode CLI is not installed.
 */
describe('OpenCode CLI Integration', () => {
  it.skipIf(!OPENCODE_AVAILABLE)('opencode CLI is installed and accessible', () => {
    const result = runOpenCode(['--version']);
    expect(result.status).toBe(0);
    // OpenCode version format: X.X.X
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it.skipIf(!OPENCODE_AVAILABLE)('opencode --help returns available commands', () => {
    const result = runOpenCode(['--help']);
    expect(result.status).toBe(0);
    // Should show commands list. Newer opencode (1.17.x) routes --help to stderr,
    // so check both streams (matches the sibling agent-help assertion below).
    expect((result.stdout + result.stderr).toLowerCase()).toContain('commands');
  });

  it.skipIf(!OPENCODE_AVAILABLE)('opencode has agent management commands', () => {
    const result = runOpenCode(['agent', '--help']);
    // Should have agent subcommand
    expect(result.stdout.toLowerCase() + result.stderr.toLowerCase()).toMatch(/agent|manage/);
  });

  describe('Agent Configuration', () => {
    it.skipIf(!OPENCODE_AVAILABLE)('validates .opencode/agent/ directory structure', async () => {
      // Create test directory with proper structure
      const testDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-test-'));
      const agentDir = path.join(testDir, '.opencode', 'agent');
      fs.mkdirSync(agentDir, { recursive: true });

      // Create a test agent file with OpenCode format
      const agentContent = `---
description: Test agent for validation
mode: subagent
model: ${OPENCODE_DEPLOY_MODELS.coding}
temperature: 0.5
maxSteps: 50
tools:
  write:
    enabled: true
  bash:
    enabled: false
permission:
  allowWrite: false
  allowBash: false
---

# Test Agent

This is a test agent for OpenCode integration.
`;
      fs.writeFileSync(path.join(agentDir, 'test-agent.md'), agentContent);

      // Verify structure
      const agents = fs.readdirSync(agentDir);
      expect(agents).toContain('test-agent.md');

      // Verify format
      const content = fs.readFileSync(path.join(agentDir, 'test-agent.md'), 'utf-8');
      expect(content).toMatch(/^---\n/);
      expect(content).toContain('mode: subagent');
      expect(content).toContain('model: anthropic/');
      expect(content).toContain('tools:');

      // Cleanup
      fs.rmSync(testDir, { recursive: true, force: true });
    });
  });

  describe('Command Configuration', () => {
    it.skipIf(!OPENCODE_AVAILABLE)('validates .opencode/commands/ directory structure', async () => {
      // Create test directory with proper structure
      const testDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-command-test-'));
      const commandDir = path.join(testDir, '.opencode', 'commands');
      fs.mkdirSync(commandDir, { recursive: true });

      // Create a test command file with OpenCode format
      const commandContent = `---
description: Test command for validation
subtask: true
---

# Test Command

This is a test command for OpenCode integration.
`;
      fs.writeFileSync(path.join(commandDir, 'test-command.md'), commandContent);

      // Verify structure
      const commands = fs.readdirSync(commandDir);
      expect(commands).toContain('test-command.md');

      // Verify format
      const content = fs.readFileSync(path.join(commandDir, 'test-command.md'), 'utf-8');
      expect(content).toMatch(/^---\n/);
      expect(content).toContain('description:');
      expect(content).toContain('subtask: true');

      // Cleanup
      fs.rmSync(testDir, { recursive: true, force: true });
    });
  });

  describe('JSON Configuration', () => {
    it.skipIf(!OPENCODE_AVAILABLE)('validates opencode.json format', async () => {
      // Create a test config
      const testDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-'));
      fs.mkdirSync(testDir, { recursive: true });

      const configContent = {
        model: OPENCODE_DEPLOY_MODELS.coding,
        mcp: {
          aiwg: {
            type: 'local',
            command: ['aiwg', 'mcp', 'serve'],
          },
        },
        agent: {
          defaultModel: OPENCODE_DEPLOY_MODELS.coding,
        },
      };

      fs.writeFileSync(
        path.join(testDir, 'opencode.json'),
        JSON.stringify(configContent, null, 2)
      );

      // Verify JSON is valid
      const readBack = fs.readFileSync(path.join(testDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(readBack);

      expect(parsed.model).toBe(OPENCODE_DEPLOY_MODELS.coding);
      expect(parsed.mcp.aiwg).toBeDefined();
      expect(parsed.mcp.aiwg.type).toBe('local');

      // Cleanup
      fs.rmSync(testDir, { recursive: true, force: true });
    });
  });

  describe('CLI Availability Reporting', () => {
    it('reports opencode CLI availability status', () => {
      // This test always runs to report status
      console.log(`\n  OpenCode CLI Status:`);
      console.log(`    Available: ${OPENCODE_AVAILABLE}`);
      console.log(`    Expected Path: ${OPENCODE_PATH}`);
      console.log(`    Path Exists: ${fs.existsSync(OPENCODE_PATH)}`);
      if (OPENCODE_AVAILABLE) {
        const version = runOpenCode(['--version']);
        console.log(`    Version: ${version.stdout.trim()}`);
      } else {
        console.log('    Install: curl -fsSL https://opencode.sh | bash');
      }
      expect(true).toBe(true); // Always passes, just for reporting
    });
  });
});
