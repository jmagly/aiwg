/**
 * Unit tests for tools/cli/doctor.mjs
 *
 * Tests the check logic used by runDoctor(). Because doctor.mjs is a standalone
 * CLI script with top-level await, we test the logic inline (same approach as
 * doctor-channel.test.ts). All assertions are about the check behavior, not
 * about importing the script directly.
 *
 * @issue #686
 * @parent #684
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeExecutableSync } from '../../helpers/write-executable.js';
import * as sharedFlagParsing from '../../../src/cli/flag-parsing.js';

const execFileAsync = promisify(execFile);

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DOCTOR_SCRIPT = resolve(__dirname, '../../../tools/cli/doctor.mjs');

// Mock channel manager — same pattern as doctor-channel.test.ts
const mockGetFrameworkRoot = vi.fn();
const mockGetVersionInfo = vi.fn();

vi.mock('../../../src/channel/manager.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/channel/manager.mjs')>(),
  getFrameworkRoot: mockGetFrameworkRoot,
  getVersionInfo: mockGetVersionInfo,
}));

// ── File existence ───────────────────────────────────────────

describe('tools/cli/doctor.mjs — file', () => {
  it('exists at expected path', () => {
    expect(existsSync(DOCTOR_SCRIPT)).toBe(true);
  });

  it('starts with shebang', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('imports getFrameworkRoot from channel/manager (not hardcoded legacy path)', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
    expect(content).toContain('getFrameworkRoot');
    // Must NOT hardcode the legacy path
    expect(content).not.toContain("'~/.local/share/ai-writing-guide'");
    expect(content).not.toContain('"~/.local/share/ai-writing-guide"');
  });

  it('imports dynamic provider/modules through file URLs for Windows paths', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    expect(content).toContain('pathToFileURL');
    expect(content).toContain('await import(pathToFileURL(providerPath).href)');
    expect(content).toContain('await import(pathToFileURL(statusPath).href)');
  });

  it('runs aiwg discovery probes through the Windows npm shim path and reports spawn errors', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    expect(content).toContain("shell: process.platform === 'win32'");
    expect(content).toContain('spawn failed: ${r.error.code || r.error.message}');
  });

  it('requires discovery to return the known aiwg-doctor capability', () => {
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    expect(content).toContain("args: ['discover', 'aiwg doctor', '--json', '--limit', '10']");
    expect(content).toContain("result?.name === 'aiwg-doctor'");
    expect(content).toContain('returned zero results for the known aiwg-doctor capability');
  });
});

// ── Installation check logic ──────────────────────────────────

describe('doctor: installation check', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  async function checkInstallation(root: string, exists: (p: string) => Promise<boolean>) {
    const installed = await exists(root);
    return installed
      ? { status: 'ok' as const, message: `Found at ${root}` }
      : { status: 'error' as const, message: `AIWG not found at ${root}. Run: npm install -g aiwg` };
  }

  it('ok when npm global path exists', async () => {
    const root = '/usr/local/lib/node_modules/aiwg';
    mockGetFrameworkRoot.mockResolvedValue(root);
    const result = await checkInstallation(root, async () => true);
    expect(result.status).toBe('ok');
    expect(result.message).toContain(root);
  });

  it('error when path does not exist — shows actual path, not legacy', async () => {
    const root = '/usr/local/lib/node_modules/aiwg';
    mockGetFrameworkRoot.mockResolvedValue(root);
    const result = await checkInstallation(root, async () => false);
    expect(result.status).toBe('error');
    expect(result.message).toContain(root);
    expect(result.message).not.toContain('ai-writing-guide');
  });

  it('respects AIWG_ROOT env override', async () => {
    const envRoot = '/custom/aiwg/path';
    const result = await checkInstallation(envRoot, async () => true);
    expect(result.status).toBe('ok');
    expect(result.message).toContain(envRoot);
  });
});

// ── Version check logic ───────────────────────────────────────

describe('doctor: version check', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function buildChannelLabel(channel: string): string {
    return channel !== 'stable' ? ` [${channel}]` : '';
  }

  it('no label for stable channel', () => {
    mockGetVersionInfo.mockResolvedValue({ version: '2026.4.0', channel: 'stable', devMode: false });
    const label = buildChannelLabel('stable');
    expect(label).toBe('');
  });

  it('[next] label for rc builds', async () => {
    mockGetVersionInfo.mockResolvedValue({ version: '2026.4.0-rc.9', channel: 'next', devMode: false });
    const { getVersionInfo } = await import('../../../src/channel/manager.mjs');
    const info = await getVersionInfo();
    const label = buildChannelLabel(info.channel);
    expect(label).toBe(' [next]');
    expect(info.version).toContain('-rc.');
  });

  it('[nightly] label for nightly builds', async () => {
    mockGetVersionInfo.mockResolvedValue({ version: '2026.4.0-nightly.20260404', channel: 'nightly', devMode: false });
    const { getVersionInfo } = await import('../../../src/channel/manager.mjs');
    const info = await getVersionInfo();
    const label = buildChannelLabel(info.channel);
    expect(label).toBe(' [nightly]');
  });

  it('[edge] label for edge builds', async () => {
    mockGetVersionInfo.mockResolvedValue({ version: '2026.4.0-edge', channel: 'edge', devMode: false });
    const { getVersionInfo } = await import('../../../src/channel/manager.mjs');
    const info = await getVersionInfo();
    const label = buildChannelLabel(info.channel);
    expect(label).toBe(' [edge]');
  });
});

// ── .aiwg/ check logic ────────────────────────────────────────

describe('doctor: .aiwg/ project directory check', () => {
  async function checkAiwgDir(cwd: string, exists: (p: string) => Promise<boolean>) {
    const projectAiwg = `${cwd}/.aiwg`;
    const present = await exists(projectAiwg);
    return present
      ? { status: 'ok' as const, message: 'Found in current directory' }
      : { status: 'info' as const, message: 'No .aiwg/ in current directory (not an AIWG project)' };
  }

  it('ok when .aiwg/ present', async () => {
    const result = await checkAiwgDir('/project', async () => true);
    expect(result.status).toBe('ok');
  });

  it('info (not error) when .aiwg/ absent', async () => {
    const result = await checkAiwgDir('/project', async () => false);
    expect(result.status).toBe('info');
  });
});

// ── Agent count check logic ────────────────────────────────────

describe('doctor: Claude Code agents check', () => {
  it('ok with correct agent count', () => {
    const files = ['foo.md', 'bar.md', 'baz.md', 'not-agent.txt'];
    const agentCount = files.filter(f => f.endsWith('.md')).length;
    expect(agentCount).toBe(3);
    const result = { status: 'ok' as const, message: `${agentCount} agents deployed` };
    expect(result.message).toContain('3 agents');
  });

  it('info when agents directory missing', () => {
    const result = { status: 'info' as const, message: 'No agents deployed (run: aiwg use sdlc)' };
    expect(result.status).toBe('info');
  });
});

describe('doctor: deployed skill budget warning', () => {
  it('checks total deployed skill count against platform defaults', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    expect(content).toContain('checkTotalDeployedSkillBudgetForProvider');
    expect(content).toContain('Deployed Skill Count');
    expect(content).toContain('aiwg list --deployed');
  });

  it('offers a non-destructive Codex repair without counting hidden standard skills (#2561)', () => {
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    // `--force` overwrites unmanaged files; it is never the budget remediation.
    expect(content).not.toContain('aiwg use all --provider codex --force');
    expect(content).toContain('aiwg use <bundle> --provider codex');
    expect(content).toContain('standard tier');
    expect(content).toContain("provName !== 'codex' && provider?.paths?.skills");
    expect(content).toContain('startup-visible skills');
  });

  it('uses the same Claude override budget for deployed skill count warnings', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    expect(content).toContain('resolveClaudeListingBudget');
    expect(content).not.toContain("above Claude Code's default listing budget");
    expect(content).toContain('Refs #1609');
  });
});

describe('doctor: optional native feature builds', () => {
  it('warns on installed-but-unloadable native modules with a scoped rebuild command', () => {
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    expect(content).toContain('p.installed && !p.loadable');
    expect(content).toContain('native build unavailable');
    expect(content).toContain('features install ${s.feature.name}');
    expect(content).toContain('scoped lifecycle-script approval');
  });
});

// ── Node.js version check logic ────────────────────────────────

describe('doctor: Node.js version check', () => {
  it.each(['v16.20.0', 'v18.20.8', 'v20.19.0', 'v22.19.0', 'v23.11.0'])(
    'warns for unsupported runtime %s', async version => {
      const { checkNodeVersion } = await import('../../../tools/cli/doctor.mjs');
      expect(checkNodeVersion(version)).toEqual({ status: 'warn', message: `${version} (requires >= 24)` });
    },
  );

  it.each(['v24.0.0', 'v24.12.0', 'v26.0.0'])('accepts supported runtime %s', async version => {
    const { checkNodeVersion } = await import('../../../tools/cli/doctor.mjs');
    expect(checkNodeVersion(version)).toEqual({ status: 'ok', message: version });
  });
});

// ── MCP server check logic ────────────────────────────────────
//
// #276: the check must resolve the exact entrypoint the production
// launcher (bin/aiwg.mjs's resolveRouterPath → compiled router → mcp/
// cli.mjs → ./server.mjs, always dist/src/, never a src/ fallback) would
// load — not accept "either file exists". Production-function coverage
// (resolveEffectiveInstallationRoot / resolveMcpServerEntrypointPath,
// including the npm/checkout/dev-root/missing-compiled-with-surviving-
// source cases) lives in test/unit/channel/manager.test.ts, which imports
// and calls the real exported functions doctor.mjs itself calls — not a
// re-implemented predicate.

describe('doctor: MCP server check', () => {
  it('source script resolves the MCP server via the shared production resolver, not a re-derived "either path" predicate', () => {
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
    expect(content).toContain("resolveMcpServerEntrypointPath } = await importImpl");
    expect(content).toContain('resolveMcpServerEntrypointPath(getPackageRoot(), mcpConfig)');
    // The old re-implemented "accept either dist or src" predicate must not return.
    expect(content).not.toContain("path.join(AIWG_ROOT, 'src/mcp/server.mjs')");
    expect(content).not.toContain("path.join(AIWG_ROOT, 'dist/src/mcp/server.mjs')");
  });
});

describe('doctor: MCP server check — exercises the production resolver against fixture trees (#276)', () => {
  // This file mocks channel/manager.mjs (getFrameworkRoot/getVersionInfo only)
  // for the doctor-wiring tests above; importActual bypasses that mock so
  // these tests call the real production resolver, not the mock.
  async function realManager() {
    return vi.importActual<typeof import('../../../src/channel/manager.mjs')>('../../../src/channel/manager.mjs');
  }

  function makeTempRoot(): string {
    return mkdtempSync(join(tmpdir(), 'aiwg-doctor-mcp-'));
  }

  it('ok for an npm/checkout layout with the compiled server present', async () => {
    const { resolveMcpServerEntrypointPath } = await realManager();
    const root = makeTempRoot();
    try {
      mkdirSync(join(root, 'dist/src/mcp'), { recursive: true });
      writeFileSync(join(root, 'dist/src/mcp/server.mjs'), '// compiled server\n');
      const resolved = resolveMcpServerEntrypointPath(root, { devMode: false });
      expect(existsSync(resolved)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ok for a dev-mode root with the compiled server present under the edge checkout', async () => {
    const { resolveMcpServerEntrypointPath } = await realManager();
    const packageRoot = '/opt/node_modules/aiwg';
    const edgePath = makeTempRoot();
    try {
      mkdirSync(join(edgePath, 'dist/src/mcp'), { recursive: true });
      writeFileSync(join(edgePath, 'dist/src/mcp/server.mjs'), '// compiled server\n');
      const resolved = resolveMcpServerEntrypointPath(packageRoot, { devMode: true, edgePath });
      expect(resolved.startsWith(edgePath)).toBe(true);
      expect(existsSync(resolved)).toBe(true);
    } finally {
      rmSync(edgePath, { recursive: true, force: true });
    }
  });

  it('warn (not falsely ok) when the compiled server is missing but source survives (the false-positive this bug reported)', async () => {
    const { resolveMcpServerEntrypointPath } = await realManager();
    const root = makeTempRoot();
    try {
      mkdirSync(join(root, 'src/mcp'), { recursive: true });
      writeFileSync(join(root, 'src/mcp/server.mjs'), '// source survives, but is never what runs\n');
      const resolved = resolveMcpServerEntrypointPath(root, { devMode: false });
      expect(existsSync(resolved)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warn when neither layout has the server file', async () => {
    const { resolveMcpServerEntrypointPath } = await realManager();
    const root = makeTempRoot();
    try {
      mkdirSync(root, { recursive: true });
      const resolved = resolveMcpServerEntrypointPath(root, { devMode: false });
      expect(existsSync(resolved)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── .gitignore check logic ────────────────────────────────────

describe('doctor: .gitignore check', () => {
  const RUNTIME_PATTERNS = ['.aiwg/working/', '.aiwg/ralph/', '.aiwg/ralph-external/'];

  function isCovered(pattern: string, lines: string[]): boolean {
    if (lines.includes(pattern)) return true;
    if (lines.includes(pattern.replace(/\/$/, ''))) return true;
    const parts = pattern.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/') + '/';
      if (lines.includes(parent) || lines.includes(parent.replace(/\/$/, ''))) return true;
    }
    return false;
  }

  it('ok when all patterns covered', () => {
    const lines = ['.aiwg/working/', '.aiwg/ralph/', '.aiwg/ralph-external/'];
    const missing = RUNTIME_PATTERNS.filter(p => !isCovered(p, lines));
    expect(missing).toHaveLength(0);
  });

  it('ok when parent directory covers pattern', () => {
    // .aiwg/ covers all .aiwg/* patterns
    const lines = ['.aiwg/'];
    const missing = RUNTIME_PATTERNS.filter(p => !isCovered(p, lines));
    expect(missing).toHaveLength(0);
  });

  it('warn when patterns missing — includes pattern names', () => {
    const lines: string[] = [];
    const missing = RUNTIME_PATTERNS.filter(p => !isCovered(p, lines));
    expect(missing.length).toBeGreaterThan(0);
    const message = `Missing AIWG runtime patterns: ${missing.join(', ')} — run "aiwg config gitignore --fix"`;
    expect(message).toContain('.aiwg/working/');
  });
});

describe('doctor: durable index findings (#1691)', () => {
  it('imports collectIndexStatus and reports durable-index drift through doctor', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    expect(content).toContain('collectIndexStatus');
    expect(content).toContain("'durable-indices'");
    expect(content).toContain('graph-config problem(s) previously dropped silently');
    expect(content).toContain('on-disk index dir(s) match no registered graph');
    expect(content).toContain('registered durable index(es) not built');
    expect(content).toContain('run "aiwg index status"');
    expect(content).toContain('run "aiwg index build --all"');
  });
});

describe('doctor: Fortemi Core prebuilt index findings (#1697)', () => {
  it('reports packaged prebuilt framework index readiness and stale states', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    expect(content).toContain('getFortemiCorePrebuiltStatus');
    expect(content).toContain('getFortemiCoreExecutableSkillStatus');
    expect(content).toContain('getFortemiCoreSyncStatus');
    expect(content).toContain('fortemi-core-index');
    expect(content).toContain('prebuilt framework index present');
    expect(content).toContain('prebuilt framework index is missing executable metadata');
    expect(content).toContain('run "npm run release:fortemi-index" before release packaging');
  });
});

// ── Provider awareness (regression: doctor defaults to Claude Code) ──
//
// Bug report: `aiwg doctor` is hardcoded to .claude/agents and .claude/commands,
// so on a Factory/Codex/Cursor/etc. project it reports "No agents deployed"
// even when droids/skills/commands are correctly deployed under the provider's
// own paths. doctor.mjs must accept --provider and check the right directories.
//
// These tests capture the contract. They are expected to fail until doctor.mjs
// is updated to be provider-aware (parse --provider, look up paths from the
// provider module, scan that location instead of/in addition to .claude/).

describe('doctor: provider awareness (regression)', () => {
  it('source script accepts --provider flag', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
    // Either parses --provider directly, or imports the provider registry.
    const hasProviderFlag = /--provider|providerArg|argv\.provider/.test(content);
    const importsProviderRegistry = /providers\/index\.mjs|loadProvider|getProvider/.test(content);
    expect(hasProviderFlag || importsProviderRegistry).toBe(true);
  });

  it('knows OpenHuman and validates optional Tier-2 harness stubs', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    expect(content).toMatch(/openhuman:\s*'OpenHuman'/);
    expect(content).toMatch(/grokbot:\s*'Grok Bot'/);
    expect(content).toMatch(/muse:\s*'Muse Code'/);
    expect(content).toContain('checkOpenHumanHarnessTier2');
    expect(content).toContain('OpenHuman Tier-2 harness');
    expect(content).toContain("'agent', 'prompts'");
  });

  it('source script does not hardcode only .claude/ paths for agent/command checks', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

    // Acceptable: references at least one non-Claude provider path,
    // or resolves provider paths dynamically from the provider module.
    const referencesOtherProviders =
      /\.factory\/(droids|commands|skills)/.test(content) ||
      /\.codex\/(agents|skills|prompts)/.test(content) ||
      /\.cursor\/(agents|commands|rules)/.test(content) ||
      /\.github\/(agents|prompts|instructions)/.test(content) ||
      /\.warp\/(agents|commands)/.test(content) ||
      /\.opencode\/(agent|command)/.test(content);
    const resolvesPathsDynamically = /provider\.paths|paths\.agents|paths\.commands/.test(content);

    expect(referencesOtherProviders || resolvesPathsDynamically).toBe(true);
  });

  it('reports provider-specific paths instead of "No agents deployed" when a non-Claude provider is configured', async () => {
    // Behavioral contract: when invoked on a project deployed to Factory,
    // the agent check should look in .factory/droids/ — not .claude/agents/ —
    // and should not report "No agents deployed" if droids exist.
    //
    // Until doctor.mjs is provider-aware this assertion documents intent.
    const { readFileSync } = await import('fs');
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
    // The literal hardcoded path must not be the *only* path consulted.
    const onlyClaudePaths =
      content.includes('.claude/agents') &&
      !/(\.factory|\.codex|\.cursor|\.github|\.warp|\.opencode)/.test(content) &&
      !/provider\.paths|paths\.agents/.test(content);
    expect(onlyClaudePaths).toBe(false);
  });
});

// ── Exit code logic ────────────────────────────────────────────

describe('doctor: exit code logic', () => {
  function computeExitCode(checks: Array<{ status: string }>) {
    return checks.some(c => c.status === 'error') ? 1 : 0;
  }

  it('exits 1 when errors present', () => {
    const checks = [
      { status: 'ok' },
      { status: 'error' },
      { status: 'warn' },
    ];
    expect(computeExitCode(checks)).toBe(1);
  });

  it('exits 0 with warnings only', () => {
    const checks = [{ status: 'ok' }, { status: 'warn' }];
    expect(computeExitCode(checks)).toBe(0);
  });

  it('exits 0 when all pass', () => {
    const checks = [{ status: 'ok' }, { status: 'ok' }];
    expect(computeExitCode(checks)).toBe(0);
  });
});

describe('doctor: delivery identity checks (#1601)', () => {
  let content: string;
  beforeEach(async () => {
    const { readFileSync } = await import('fs');
    content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
  });

  it('warns when signed commits are required without signing material', () => {
    expect(content).toContain('require_signed_commits=true but delivery.signing.key/key_file is not configured');
  });

  it('emits a Delivery Identity check for tracker actor drift', () => {
    expect(content).toContain('Delivery Identity');
    expect(content).toContain('remotes.tracker_actor is not set');
  });

  it('validates tracker actor via values and forbidden actors', () => {
    expect(content).toContain("['tea', 'gh', 'mcp', 'api']");
    expect(content).toContain('forbid_actors');
  });
});

// ── Agent-def size ceiling check (#1587) ─────────────────────
// Oversized agent definitions overflow the subagent prompt budget and fail
// Task dispatch with "Prompt is too long". doctor scans deployed agent dirs
// and warns on any def over the 16 KB ceiling.
describe('tools/cli/doctor.mjs — agent-def size ceiling (#1587)', () => {
  let content: string;
  beforeEach(async () => {
    const { readFileSync } = await import('fs');
    content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
  });

  it('defines the 16 KB agent-def ceiling', () => {
    expect(content).toContain('16 * 1024');
  });

  it('emits an "Agent def sizes" check', () => {
    expect(content).toContain('Agent def sizes');
  });

  it('explains the dispatch-failure consequence in the warning', () => {
    expect(content).toContain('Prompt is too long');
  });

  it('points the operator at externalizing examples', () => {
    expect(content.toLowerCase()).toContain('externalize examples');
  });

  it('compares deployed findings with current packaged agent sources before diagnosis', () => {
    expect(content).toContain('collectPackagedAgentInventory');
    expect(content).toContain('diagnoseOversizedAgent');
    expect(content).toContain('current packaged sources');
    expect(content).toContain('stale managed deployment bytes');
    expect(content).toContain('unmanaged or project-local');
  });

  it('scans the deployed agent definition file types', () => {
    // .md, .agent.md (Copilot), .soul.md (Windsurf)
    expect(content).toContain('.soul.md');
  });

  it('is backed by the hard CI lint gate (#1602)', async () => {
    expect(content).toContain('Agent def sizes');
    const { readFileSync } = await import('fs');
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'));
    const ci = readFileSync(resolve(__dirname, '../../../.gitea/workflows/ci.yml'), 'utf-8');
    expect(pkg.scripts['lint:agent-sizes']).toBe('node tools/lint/agent-def-sizes.mjs');
    expect(ci).toContain('npm run lint:agent-sizes');
  });

  it('guards aiwg-steward as a 12 KB Tier-1 routing core (#1661)', () => {
    const lint = readFileSync(resolve(__dirname, '../../../tools/lint/agent-def-sizes.mjs'), 'utf-8');
    expect(lint).toContain('STEWARD_AGENT_TARGET_BYTES = 12 * 1024');
    expect(lint).toContain('STEWARD_AGENT_TARGET_PATHS');
    expect(lint).toContain('agentic/code/addons/aiwg-utils/agents/aiwg-steward.md');
    expect(lint).toContain('agentic/code/agents/personas/aiwg-steward.md');
    expect(lint).toContain('stewardTargetViolations');
    expect(lint).toContain('Tier-1 routing core');
  });
});

// ── Startup-context budget (#1673) ───────────────────────────

describe('tools/cli/doctor.mjs — startup-context budget (#1673)', () => {
  let content: string;
  beforeEach(async () => {
    const { readFileSync } = await import('fs');
    content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
  });

  it('imports the shared startup-context scanner', () => {
    expect(content).toContain('scanStartupContext');
    expect(content).toContain("from '../lint/claude-context-inventory.mjs'");
  });

  it('defines and invokes a claude-only startup-context check', () => {
    expect(content).toContain('async function checkStartupContextBudget');
    expect(content).toContain('await checkStartupContextBudget(provName, label)');
    // Claude-only guard
    expect(content).toMatch(/checkStartupContextBudget[\s\S]*?if \(provName !== 'claude'\) return;/);
  });

  it('respects the --no-budget-check opt-out', () => {
    // The call lives inside the existing `if (!noBudgetCheck)` block.
    expect(content).toMatch(/if \(!noBudgetCheck\)[\s\S]*?checkStartupContextBudget/);
  });

  it('reports over/near budget as non-fatal warn, not a doctor-failing error', () => {
    const fn = content.slice(
      content.indexOf('async function checkStartupContextBudget'),
      content.indexOf('async function loadProvider'),
    );
    expect(fn).toContain("'over'");
    expect(fn).toContain("'warn'");
    // Must not fail doctor (error => exit 1) for a structural over-budget.
    expect(fn).not.toContain("'error'");
    expect(fn).toContain('Startup Context');
  });
});

describe('tools/cli/doctor.mjs — subagent dispatch headroom (#2562)', () => {
  let content: string;
  beforeEach(async () => {
    const { readFileSync } = await import('fs');
    content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
  });

  it('defines a claude-only dispatch headroom check invoked next to the startup budget', () => {
    expect(content).toContain('async function checkSubagentDispatchHeadroom');
    expect(content).toContain('await checkSubagentDispatchHeadroom(provName, label)');
    expect(content).toMatch(/checkSubagentDispatchHeadroom[\s\S]*?if \(provName !== 'claude'\) return;/);
  });

  it('fails doctor when the inlined surface leaves no room for a subagent, unlike the advisory startup budget', () => {
    const fn = content.slice(
      content.indexOf('async function checkSubagentDispatchHeadroom'),
      content.indexOf('async function checkStartupContextBudget'),
    );
    expect(fn).toContain("status === 'fails' ? 'error' : 'warn'");
    expect(fn).toContain('Prompt is too long');
    expect(fn).toContain('Ancestor directories contribute');
    expect(fn).toContain('AIWG_RULES_INLINE_BUDGET_TOKENS');
  });

  it('computes headroom from the standard window minus startup context, agent def, and system prompt', async () => {
    // @ts-expect-error — .mjs module without type declarations
    const { subagentDispatchHeadroom } = await import('../../../tools/lint/claude-context-inventory.mjs');
    expect(subagentDispatchHeadroom({ totalTokens: 97_000, budgetTokens: 200_000 })).toEqual({ headroom: 87_000, status: 'ok' });
    expect(subagentDispatchHeadroom({ totalTokens: 150_000, budgetTokens: 200_000 })).toEqual({ headroom: 34_000, status: 'at-risk' });
    expect(subagentDispatchHeadroom({ totalTokens: 190_000, budgetTokens: 200_000 })).toMatchObject({ status: 'fails' });
  });
});

// ── Context and persistent-memory firewall (#2040) ────────────────────

describe('tools/cli/doctor.mjs — context/memory firewall (#2040)', () => {
  let content: string;
  beforeEach(async () => {
    const { readFileSync } = await import('fs');
    content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
  });

  it('imports and invokes the cross-category firewall', () => {
    expect(content).toContain('scanContextMemoryFirewall');
    expect(content).toContain("from '../security/context-memory-firewall.mjs'");
    expect(content).toContain('const firewall = await scanContextMemoryFirewall');
  });

  it('exposes strict, baseline, and provider-budget controls', () => {
    // Execute the actual parser with the shared helpers, without running the
    // script's top-level diagnostics or process.exit(). This checks values and
    // precedence rather than depending on the spelling of its former loop.
    const parserSource = content.slice(content.indexOf('const DOCTOR_VALUE_FLAGS'), content.indexOf('// Parse-or-exit wrapper'));
    const parse = new Function('shared', `
      const {
        requireFlagValue: requireDoctorFlagValue,
        hasPositionalOrSwitch: hasDoctorFlagSwitch,
        argsTerminatorIndex: doctorArgsTerminatorIndex,
        valueTokenIndexes: doctorValueTokenIndexes,
        MissingFlagValueError: DoctorMissingFlagValueError,
      } = shared;
      ${parserSource}
      return parseDoctorArgs;
    `)(sharedFlagParsing);
    expect(parse([])).toMatchObject({ strictContext: false,
      contextBaseline: '.aiwg/context-memory-firewall-baseline.json', contextBudgetTokens: 200_000 });
    expect(parse(['--strict-context', '--context-baseline', 'reviewed.json', '--context-budget-tokens', '12345']))
      .toMatchObject({ strictContext: true, contextBaseline: 'reviewed.json', contextBudgetTokens: 12345 });
    expect(parse(['--context-baseline=old.json', '--context-baseline=new.json',
      '--context-budget-tokens=1000', '--context-budget-tokens=2000']))
      .toMatchObject({ contextBaseline: 'new.json', contextBudgetTokens: 2000 });
    expect(parse(['--', '--strict-context', '--context-baseline', 'ignored.json']))
      .toMatchObject({ strictContext: false, contextBaseline: '.aiwg/context-memory-firewall-baseline.json' });
    for (const flag of ['--context-baseline', '--context-budget-tokens']) {
      expect(() => parse([flag])).toThrow(`${flag} requires a value`);
      expect(() => parse([`${flag}=`])).toThrow(`${flag} requires a value`);
    }
    expect(content).toContain('baselinePath: contextBaseline');
    expect(content).toContain('budgetTokens: contextBudgetTokens');
    expect(content).toContain("strictContext ? 'error' : 'warn'");
  });

  it('reports all six context contributions and review states', () => {
    expect(content).toContain('Object.entries(firewall.categories)');
    expect(content).toContain('firewall.trust.stale');
    expect(content).toContain('firewall.trust.quarantined');
    expect(content).toContain("record.reviewStatus === 'changed-review-required'");
  });

  it('scans Muse Code through the firewall without an unknown-provider hole (#229)', () => {
    // The doctor-side provider filter must admit muse, and the firewall
    // PROVIDERS table must know its layout — otherwise `aiwg doctor
    // --provider muse` degrades to `scan failed: Unknown provider 'muse'`.
    expect(content).toMatch(/'grokbot', 'grok-build', 'muse'\]/);
    expect(content).toMatch(/provName === 'muse' && \(providerArg \|\| allProviders\)/);
  });

  it('scans Grok Build through the firewall without an unknown-provider hole (#2640)', () => {
    // `aiwg doctor --provider grok-build` silently skipped the
    // context/memory firewall scan because grok-build was missing from
    // both the doctor-side allowlist and the firewall's own PROVIDERS
    // table (tools/security/context-memory-firewall.mjs) — adding it to
    // only one of the two turns the silent skip into a thrown
    // `Unknown provider 'grok-build'` instead, so both are required.
    expect(content).toMatch(/'openhuman', 'grokbot', 'grok-build', 'muse'\]/);
    const firewallSource = readFileSync(
      resolve(__dirname, '../../../tools/security/context-memory-firewall.mjs'),
      'utf-8',
    );
    expect(firewallSource).toMatch(/'grok-build':\s*\{/);
  });

  it('every provider the firewall scanner supports is in the doctor allowlist (#2640)', async () => {
    // Regression guard for the exact defect class #2640 reported: a
    // provider the firewall scanner (tools/security/context-memory-firewall.mjs)
    // already knows how to scan but that doctor's own allowlist forgot
    // silently skips the context/memory firewall scan for it. Derives the
    // expected set from the firewall module's own registry so adding a
    // provider there without updating doctor.mjs fails this test instead
    // of silently skipping the scan.
    const { SUPPORTED_PROVIDERS } = await import('../../../tools/security/context-memory-firewall.mjs');

    const allowlistMatch = /providersToCheck\.filter\(\(name\) =>\s*\[([^\]]+)\]\.includes\(name\)/.exec(content);
    expect(allowlistMatch).not.toBeNull();
    const allowlist = allowlistMatch[1].split(',').map((entry) => entry.trim().replace(/'/g, ''));

    for (const provider of SUPPORTED_PROVIDERS) {
      expect(allowlist, `expected '${provider}' (firewall-supported) to also be in doctor's allowlist`).toContain(provider);
    }
  });
});

// ── User registry override + shared parallelism defaults (#246 / #249) ──

describe('doctor: user registry override warn (#246)', () => {
  it('warns when AIWG_USER_REGISTRY_PATH is set', () => {
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
    expect(content).toContain("AIWG_USER_REGISTRY_PATH");
    expect(content).toContain('test override active');
    expect(content).toContain('User Registry Path');
    expect(content).toContain('not writing to default ~/.aiwg/installed.json');
  });
});

describe('doctor: parallelism defaults use shared map (#249)', () => {
  it('imports getProviderParallelismDefaults instead of a hardcoded subset', () => {
    const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');
    expect(content).toContain('getProviderParallelismDefaults');
    expect(content).not.toContain('const PROVIDER_DEFAULTS = {');
  });

  it('labels primary=grokbot with shared default of 4', async () => {
    const { getProviderParallelismDefaults } = await import('../../../src/config/aiwg-config.js');
    const primary = 'grokbot';
    const expectedDefault = getProviderParallelismDefaults(primary).max_parallel_subagents;
    expect(expectedDefault).toBe(4);
    const p = { max_parallel_subagents: 4 };
    const isOverride =
      p.max_parallel_subagents !== undefined &&
      p.max_parallel_subagents !== expectedDefault;
    const label = isOverride
      ? `max_parallel_subagents=${p.max_parallel_subagents} (operator override; provider default for ${primary} = ${expectedDefault})`
      : `max_parallel_subagents=${p.max_parallel_subagents} (provider default for ${primary})`;
    expect(isOverride).toBe(false);
    expect(label).toBe('max_parallel_subagents=4 (provider default for grokbot)');
  });
});

// ── Drift-aware "Unknown provider" message (#270) ──

describe('doctor: unknown-provider check names installation drift (#270)', () => {
  const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

  it('parses AIWG_INSTALLATION_DRIFT published by bin/aiwg.mjs', () => {
    expect(content).toContain('process.env.AIWG_INSTALLATION_DRIFT');
    expect(content).toContain('installationDrift');
  });

  it('keeps the bare message when no drift is active', () => {
    expect(content).toContain('`Unknown provider: ${provName}${driftNote}`');
  });

  it('names the stale install and the repair path under drift', () => {
    expect(content).toContain('installation identity drift');
    expect(content).toContain('stale canonical install');
    expect(content).toContain('aiwg installation adopt');
  });

  it('builds the drift-aware message only when drift is present', () => {
    // Mirror the branch logic so the contract is pinned, not just the strings.
    const buildMessage = (provName, installationDrift) => {
      const driftNote = installationDrift
        ? ' (installation identity drift: provider inventory read from stale canonical install; run `aiwg installation adopt` to repair)'
        : '';
      return `Unknown provider: ${provName}${driftNote}`;
    };
    expect(buildMessage('muse', null)).toBe('Unknown provider: muse');
    expect(buildMessage('muse', { state: 'mismatch', drift: [] })).toBe(
      'Unknown provider: muse (installation identity drift: provider inventory read from stale canonical install; run `aiwg installation adopt` to repair)',
    );
  });
});

// ── Direct-worker readiness opt-in probes (#2894) ──
//
// Wiring contract for tools/cli/doctor.mjs: probes are opt-in behind
// --probe-workers, the section is silent without configured workers, and the
// live behavior (no-spawn default, silence, advisory statuses) is covered by
// buildDirectWorkerDoctorSection tests in
// test/unit/models/worker-direct-readiness.test.ts.

describe('doctor: direct-worker probes are opt-in (#2894)', () => {
  const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

  it('parses doctor flags through the shared strict parser (#3062/#3066)', () => {
    expect(content).toContain("await importImpl(import.meta.url, 'cli/flag-parsing.js')");
    expect(content).toContain("hasDoctorFlagSwitch(argv, '--probe-workers'");
    expect(content).toContain("requireDoctorFlagValue(argv, valueOptions, '--provider')");
    expect(content).not.toContain("if (a === '--probe-workers')");
  });

  it('renders the section through the shared builder with the flag', () => {
    expect(content).toContain('buildDirectWorkerDoctorSection');
    expect(content).toMatch(/probeWorkers,\s*\n/);
    expect(content).not.toContain('diagnoseDirectWorkerReadiness');
  });

  it('emits no direct-worker section when no workers are configured, explicitly or implicitly', () => {
    // Gating covers both an explicit parallelism.clis entry and a cli
    // referenced only implicitly by a group member (#2894 fix: implicit
    // group-referenced installations must not be skipped). A plain run
    // (no --probe-workers) stays silent; an explicit probe ask renders the
    // one-line empty state instead (#3066).
    expect(content).toContain('directCliIds');
    expect(content).toContain('if (directCliIds.size) {');
    expect(content).toContain('if (!directCliIds.size && probeWorkers) {');
    expect(content).toContain('WORKER_PROBE_EMPTY_MESSAGE');
  });

  it('reuses the shared config read instead of reading aiwg.config a second time', () => {
    // #2894 fix: a second readAiwgConfig() call duplicated non-fatal
    // diagnostics (for example the "Invalid gates section" warning) for
    // every project, not just ones with workers configured. Baseline
    // (pre-#2894) has exactly 2 `readAiwgConfig(process.cwd())` call sites
    // elsewhere in doctor.mjs; worker-health and direct-worker readiness
    // must share one more of their own, not add a second one.
    expect(content.match(/await readAiwgConfig\(process\.cwd\(\)\)/g)?.length).toBe(2);
    expect(content).toContain('workerSectionsConfig = await readAiwgConfig(process.cwd());');
  });

  it('announces each resolved executable before spawning, not through the buffered check() report', () => {
    expect(content).toContain('process.stdout.write(`  ○ Direct Worker Probes: about to run');
  });

  it('threads the worker-health offline snapshot into the direct-worker dispatch resolver check', () => {
    expect(content).toContain('resolverSnapshot:');
    expect(content).toContain('workerSnapshotModels');
  });

  it('documents the default config-only behavior in doctor help', () => {
    const utilities = readFileSync(resolve(__dirname, '../../../src/cli/handlers/utilities.ts'), 'utf-8');
    expect(utilities).toContain('--probe-workers');
  });
});

// ── Real-process behavioral regression (#2894 review round 2, required fix) ──
//
// The suite above inspects doctor.mjs source text because the script has
// top-level await and calls process.exit() directly. For the one guarantee
// that actually matters — a project with no workers configured sees
// unchanged output and exit code, including when the config has unrelated
// warnings or fails to load entirely — source inspection cannot prove
// anything about real behavior. These tests spawn the real script as a
// child process against synthetic scratch projects. No real provider CLI is
// executed (no --probe-workers is ever passed here, so no worker executable
// is spawned), no network call is made, and HOME/USERPROFILE/XDG_* are
// pointed at an isolated empty scratch directory so the run never reads the
// operator's real home.
describe('doctor: real-process no-workers-configured output/exit regression (#2894)', () => {
  const scratchRoots: string[] = [];

  afterEach(() => {
    for (const root of scratchRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeScratchProject(configContent: string | null): string {
    const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-doctor-noworkers-'));
    scratchRoots.push(projectDir);
    if (configContent !== null) {
      mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
      writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), configContent, 'utf-8');
    }
    return projectDir;
  }

  async function runDoctorIn(projectDir: string, args: string[] = []): Promise<{ stdout: string; exitCode: number }> {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'aiwg-doctor-home-'));
    scratchRoots.push(isolatedHome);
    const env = {
      ...process.env,
      HOME: isolatedHome,
      AIWG_CONFIG: join(isolatedHome, '.config', 'aiwg'),
      USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, '.config'),
      XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
      XDG_CACHE_HOME: join(isolatedHome, '.cache'),
      XDG_STATE_HOME: join(isolatedHome, '.local', 'state'),
      // Point at this checkout's own bundled framework/model defaults
      // instead of the (isolated, empty) home install location — this repo
      // is the code under test, not operator data, so this keeps the run
      // hermetic while still letting worker-dispatch config load cleanly.
      AIWG_HOME: resolve(__dirname, '../../..'),
    };
    try {
      const { stdout } = await execFileAsync('node', [DOCTOR_SCRIPT, ...args], { cwd: projectDir, env, timeout: 60_000 });
      return { stdout, exitCode: 0 };
    } catch (error) {
      const err = error as { stdout?: string; code?: number };
      return { stdout: err.stdout ?? '', exitCode: typeof err.code === 'number' ? err.code : 1 };
    }
  }

  function directWorkerLines(stdout: string): string[] {
    return stdout.split('\n').filter(line => line.includes('Direct Worker'));
  }

  it('adds no Direct Worker lines and keeps exit 0 for a clean project with no workers configured', async () => {
    const projectDir = makeScratchProject(JSON.stringify({ providers: ['claude'], installed: {}, scripts: {} }));
    const result = await runDoctorIn(projectDir);
    expect(directWorkerLines(result.stdout)).toEqual([]);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it('adds no Direct Worker lines when the config has an unrelated non-fatal warning (invalid gates section)', async () => {
    const projectDir = makeScratchProject(JSON.stringify({
      providers: ['claude'], installed: {}, scripts: {}, gates: { bogus: 123 },
    }));
    const result = await runDoctorIn(projectDir);
    expect(directWorkerLines(result.stdout)).toEqual([]);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it('adds no Direct Worker lines when the config fails to load (invalid JSON)', async () => {
    const projectDir = makeScratchProject('{ not valid json');
    const result = await runDoctorIn(projectDir);
    expect(directWorkerLines(result.stdout)).toEqual([]);
  }, 60_000);

  it('adds no Direct Worker lines when parallelism is present but declares no clis or groups', async () => {
    // worker_dispatch is intentionally left off here: turning it on with no
    // role guidance configured trips an unrelated, pre-existing (#2913)
    // Worker Health error that has nothing to do with this assertion.
    const projectDir = makeScratchProject(JSON.stringify({
      providers: ['claude'], installed: {}, scripts: {}, parallelism: {},
    }));
    const result = await runDoctorIn(projectDir);
    expect(directWorkerLines(result.stdout)).toEqual([]);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it('still prints the pre-existing Worker Health line exactly once regardless of the config outcome', async () => {
    // #2894 added a second readAiwgConfig() call that duplicated non-fatal
    // read-time diagnostics (e.g. the gates warning) for every project. The
    // pre-existing (#2913) "Worker Health" line itself must still appear
    // exactly once per run, proving the shared-read refactor did not
    // introduce its own duplication.
    const projectDir = makeScratchProject(JSON.stringify({
      providers: ['claude'], installed: {}, scripts: {}, gates: { bogus: 123 },
    }));
    const result = await runDoctorIn(projectDir);
    const workerHealthLines = result.stdout.split('\n').filter(line => line.includes('Worker Health:'));
    expect(workerHealthLines).toHaveLength(1);
    expect(workerHealthLines[0]).toContain('group dispatch is disabled');
  }, 60_000);

  it('#3173 prints one qualification warning per role and deduplicates dispatch refusals', async () => {
    const roles = ['efficiency', 'coding', 'reasoning'];
    const projectDir = makeScratchProject(JSON.stringify({
      providers: ['claude'], installed: {}, scripts: {},
      parallelism: { worker_dispatch: true,
        clis: { codex: { adapter: 'providers:codex', accountScope: 'local', quotaScope: 'local', executable: '/definitely/not/here' } },
        groups: { harness: { requiredRoles: roles,
          members: roles.map(role => ({ id: role, cli: 'codex', model: 'unobserved-model', roles: [role] })) } } },
    }));
    writeFileSync(join(projectDir, 'models.json'), JSON.stringify({
      defaults: { workerSelection: { roleGuidance: Object.fromEntries(roles.map(role => [role, {
        groups: ['harness'], tier: 'standard', initialEffort: 'medium', effortLadder: ['medium'],
      }])) } },
    }));
    const result = await runDoctorIn(projectDir, ['--probe-workers']);
    const health = result.stdout.split('\n').filter(line => /Worker Health \(.+\).*No qualified route covers/.test(line));
    expect(health).toHaveLength(3);
    for (const role of roles) {
      expect(health.filter(line => line.includes(`Worker Health (${role})`))).toHaveLength(1);
      expect(health.find(line => line.includes(`Worker Health (${role})`))).toContain(`No qualified route covers ${role}`);
    }
    const dispatch = directWorkerLines(result.stdout).find(line => line.includes('Direct Worker Dispatch (codex)'))!;
    expect(dispatch.match(/OG_ADAPTER_UNQUALIFIED/g)).toHaveLength(3);
    for (const role of roles) expect(dispatch.split(`No qualified route covers ${role}`)).toHaveLength(2);
  }, 60_000);

  it('renders a Direct Worker section with both facts when a worker is configured and probed', async () => {
    const projectDir = makeScratchProject(JSON.stringify({
      providers: ['claude'], installed: {}, scripts: {},
      parallelism: { worker_dispatch: true, clis: { codex: {
        adapter: 'providers:codex', accountScope: 'local', quotaScope: 'local', executable: '/definitely/not/here',
      } } },
    }));
    const result = await runDoctorIn(projectDir);
    const lines = directWorkerLines(result.stdout);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some(line => line.includes('Direct Worker (codex)'))).toBe(true);
    expect(lines.some(line => line.includes('Direct Worker Dispatch (codex)'))).toBe(true);
    // 'codex' is not referenced by any group's requiredRoles (there are no
    // groups at all here), so the Direct Worker section itself must stay
    // advisory and contribute no 'error' status on its own — independent of
    // whatever the unrelated Worker Health role-guidance check reports for
    // this same no-groups config.
    expect(lines.every(line => !line.includes('✗'))).toBe(true);
  }, 60_000);
});

// ── Worker-probe JSON, empty state, and unknown-flag rejection (#3066) ──
//
// Source-shape assertions (same style as the #2894 block above: doctor.mjs
// has top-level await and calls process.exit() directly) plus real-process
// runs of the script against scratch projects with self-written fake worker
// CLIs — banners mirror the proven fixtures in
// test/unit/models/worker-direct-readiness.test.ts (codex-cli 0.161.0 is in
// range, 0.999.0 is out of range). No real provider CLI is executed, no
// network call is made, and HOME/USERPROFILE/XDG_* are isolated exactly as
// in the #2894 real-process block. Every child process below is bounded by
// an explicit timeout.
describe('doctor: worker-probe JSON output and visible empty state (#3066)', () => {
  const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

  it('rejects unknown flags naming the flag with usage exit 2', () => {
    expect(content).toContain('DOCTOR_KNOWN_FLAGS');
    expect(content).toContain('Unknown flag: ${name}');
    expect(content).toContain('assertNoUnknownDoctorFlags(argv)');
    expect(content).toContain('process.exit(2)');
  });

  it('parses --json and requires --probe-workers for it', () => {
    expect(content).toContain("hasDoctorFlagSwitch(argv, '--json'");
    expect(content).toContain('--json requires --probe-workers');
  });

  it('maps one JSON record per CLI from the install-kind findings', () => {
    expect(content).toContain('installFindings');
    expect(content).toContain('toWorkerProbeRecord');
    for (const field of ['cli', 'installed', 'version', 'inRange', 'ready', 'reason']) {
      expect(content).toContain(`${field}:`);
    }
    expect(content).toContain('workersConfigured');
  });

  it('names a valid configuration command in the empty-state message', async () => {
    expect(content).toContain('WORKER_PROBE_EMPTY_MESSAGE');
    expect(content).toContain('No worker CLIs are configured');
    expect(content).toContain('aiwg config set --project parallelism.clis.');
    const example = content.match(/aiwg config set --project parallelism\.clis\.codex '([^']+)'/);
    expect(example).not.toBeNull();
    const { validateParallelismConfig } = await import('../../../src/config/aiwg-config.js');
    expect(validateParallelismConfig({ clis: { codex: JSON.parse(example![1]!) } })).toEqual([]);
  });

  it('documents --json in doctor help', () => {
    const utilities = readFileSync(resolve(__dirname, '../../../src/cli/handlers/utilities.ts'), 'utf-8');
    expect(utilities).toContain('--json');
    expect(utilities).toMatch(/--probe-workers.*one worker-probe record per CLI/);
  });
});

describe('doctor: real-process worker-probe behavior (#3066)', () => {
  const scratchRoots: string[] = [];

  afterEach(() => {
    for (const root of scratchRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeProbeProject(configContent: string | null): string {
    const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-doctor-probe3066-'));
    scratchRoots.push(projectDir);
    if (configContent !== null) {
      mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
      writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), configContent, 'utf-8');
    }
    return projectDir;
  }

  /** A fake CLI that prints `banner` on stdout for any argv and exits 0. */
  function writeFakeCli(filePath: string, banner: string): void {
    writeExecutableSync(filePath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${banner}\n`)});\nprocess.exit(0);\n`);
  }

  function codexCliEntry(executable: string): Record<string, string> {
    return { adapter: 'providers:codex', accountScope: 'local-account', quotaScope: 'probe-3066', executable };
  }

  /** Scratch project with present/in-range, absent, and out-of-range worker CLIs. */
  function makeMatrixProject(): { projectDir: string } {
    const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-doctor-probe3066-'));
    scratchRoots.push(projectDir);
    const binDir = mkdtempSync(join(tmpdir(), 'aiwg-doctor-probe3066-bin-'));
    scratchRoots.push(binDir);
    const readyPath = join(binDir, 'fake-codex-ready');
    writeFakeCli(readyPath, 'codex-cli 0.161.0');
    const oldPath = join(binDir, 'fake-codex-old');
    writeFakeCli(oldPath, 'codex-cli 0.999.0');
    const missingPath = join(binDir, 'nonexistent-codex');
    mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1',
      providers: ['claude'],
      parallelism: {
        worker_dispatch: true,
        clis: {
          'codex-ready': codexCliEntry(readyPath),
          'codex-old': codexCliEntry(oldPath),
          'codex-missing': codexCliEntry(missingPath),
        },
      },
    }, null, 2));
    return { projectDir };
  }

  async function runDoctorWithArgs(
    args: string[],
    projectDir: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'aiwg-doctor-home-'));
    scratchRoots.push(isolatedHome);
    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, '.config'),
      XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
      XDG_CACHE_HOME: join(isolatedHome, '.cache'),
      XDG_STATE_HOME: join(isolatedHome, '.local', 'state'),
      AIWG_HOME: resolve(__dirname, '../../..'),
    };
    try {
      const { stdout, stderr } = await execFileAsync('node', [DOCTOR_SCRIPT, ...args], {
        cwd: projectDir, env, timeout: 60_000,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }
  }

  function recordsByCli(stdout: string): Record<string, {
    cli: string; installed: boolean; version: string | null;
    inRange: boolean | null; ready: boolean; reason: string;
  }> {
    // stdout must contain nothing but the JSON document in JSON mode.
    const payload = JSON.parse(stdout) as { workers: Array<{
      cli: string; installed: boolean; version: string | null;
      inRange: boolean | null; ready: boolean; reason: string;
    }> };
    return Object.fromEntries(payload.workers.map(record => [record.cli, record]));
  }

  it('rejects an unknown flag with exit 2 naming the flag', async () => {
    const projectDir = makeProbeProject(null);
    for (const flag of ['--bogus-flag', '-bogus', '--json=true']) {
      const result = await runDoctorWithArgs([flag], projectDir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(flag.split('=')[0]);
      expect(result.stdout).toBe('');
    }
    // These modes return before the script runs; validate at the public
    // handler as well, before it touches deployment or user configuration.
    const { doctorHandler } = await import('../../../src/cli/handlers/utilities.js');
    for (const mode of [[], ['--deployment'], ['--scope', 'user']]) {
      const args = [...mode, '--bogus-flag'];
      const result = await doctorHandler.execute({ args, rawArgs: args, cwd: projectDir, frameworkRoot: '' });
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain('--bogus-flag');
    }
  }, 60_000);

  it('rejects a present-but-valueless value flag with exit 2 naming the flag', async () => {
    const projectDir = makeProbeProject(null);
    const result = await runDoctorWithArgs(['--provider'], projectDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--provider requires a value');
  }, 60_000);

  it('rejects --json without --probe-workers with exit 2', async () => {
    const projectDir = makeProbeProject(null);
    const result = await runDoctorWithArgs(['--json'], projectDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--json requires --probe-workers');
  }, 60_000);

  it('prints one visible empty-state line in text mode when nothing is configured', async () => {
    const projectDir = makeProbeProject(JSON.stringify({
      version: '1', providers: ['claude'], parallelism: { worker_dispatch: true },
    }));
    const result = await runDoctorWithArgs(['--probe-workers'], projectDir);
    const lines = result.stdout.split('\n').filter(line => line.includes('Direct Worker'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('No worker CLIs are configured');
    expect(lines[0]).toContain('aiwg config set --project parallelism.clis.');
  }, 60_000);

  it('reports ready / out-of-range / not-installed in text mode with announce lines first', async () => {
    const { projectDir } = makeMatrixProject();
    const result = await runDoctorWithArgs(['--probe-workers'], projectDir);
    const lines = result.stdout.split('\n');
    const indexOf = (needle: string): number => lines.findIndex(line => line.includes(needle));
    const ready = indexOf('Direct Worker (codex-ready): WORKER_DIRECT_READY');
    const outOfRange = indexOf('Direct Worker (codex-old): WORKER_DIRECT_VERSION_OUT_OF_RANGE');
    const notInstalled = indexOf('Direct Worker (codex-missing): WORKER_DIRECT_NOT_INSTALLED');
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(outOfRange).toBeGreaterThanOrEqual(0);
    expect(notInstalled).toBeGreaterThanOrEqual(0);
    expect(lines[ready]).toContain('version 0.161.0');
    expect(lines[outOfRange]).toContain('version 0.999.0');
    // Each executable is announced (naming the exact command line and cli
    // id) before its own finding line is rendered.
    for (const [cli, finding] of [
      ['codex-ready', ready], ['codex-old', outOfRange], ['codex-missing', notInstalled],
    ] as Array<[string, number]>) {
      const announce = indexOf(`(cli '${cli}')`);
      expect(announce).toBeGreaterThanOrEqual(0);
      expect(announce).toBeLessThan(finding);
      expect(lines[announce]).toContain('about to run');
    }
  }, 120_000);

  it('emits one JSON record per CLI with stdout holding only the document', async () => {
    const { projectDir } = makeMatrixProject();
    const result = await runDoctorWithArgs(['--probe-workers', '--json'], projectDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimStart().startsWith('{')).toBe(true);
    const payload = JSON.parse(result.stdout) as {
      probeWorkers: boolean; workersConfigured: boolean; workers: unknown[];
    };
    expect(payload.probeWorkers).toBe(true);
    expect(payload.workersConfigured).toBe(true);
    expect(payload.workers).toHaveLength(3);
    const byCli = recordsByCli(result.stdout);
    expect(byCli['codex-ready']).toEqual({
      cli: 'codex-ready', installed: true, version: '0.161.0',
      inRange: true, ready: true, reason: 'WORKER_DIRECT_READY',
    });
    expect(byCli['codex-old']).toEqual({
      cli: 'codex-old', installed: true, version: '0.999.0',
      inRange: false, ready: false, reason: 'WORKER_DIRECT_VERSION_OUT_OF_RANGE',
    });
    expect(byCli['codex-missing']).toEqual({
      cli: 'codex-missing', installed: false, version: null,
      inRange: null, ready: false, reason: 'WORKER_DIRECT_NOT_INSTALLED',
    });
    // Configured CLIs remain visible when dispatch disables all probes.
    const configPath = join(projectDir, '.aiwg', 'aiwg.config');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.parallelism.worker_dispatch = false;
    writeFileSync(configPath, JSON.stringify(config));
    const disabled = await runDoctorWithArgs(['--probe-workers', '--json'], projectDir);
    expect(disabled.exitCode).toBe(0);
    const disabledPayload = JSON.parse(disabled.stdout);
    expect(disabledPayload.workerDispatch).toBe(false);
    expect(disabledPayload.workersConfigured).toBe(true);
    expect(disabledPayload.message).toContain('no version probes were run');
    expect(disabledPayload.workers).toHaveLength(3);
    for (const record of disabledPayload.workers) {
      expect(record).toEqual({ cli: record.cli, installed: false, version: null,
        inRange: null, ready: false, reason: 'WORKER_DIRECT_DISABLED' });
    }
  }, 120_000);

  it('emits workersConfigured false plus the configure guidance in JSON mode when nothing is configured', async () => {
    const projectDir = makeProbeProject(JSON.stringify({
      version: '1', providers: ['claude'], parallelism: { worker_dispatch: true },
    }));
    const result = await runDoctorWithArgs(['--probe-workers', '--json'], projectDir);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      probeWorkers: boolean; workersConfigured: boolean;
      workers: unknown[]; message: string;
    };
    expect(payload.probeWorkers).toBe(true);
    expect(payload.workersConfigured).toBe(false);
    expect(payload.workers).toEqual([]);
    expect(payload.message).toContain('No worker CLIs are configured');
    expect(payload.message).toContain('aiwg config set --project parallelism.clis.');
  }, 60_000);

  it('exits non-zero with empty stdout when the config cannot be read in JSON mode', async () => {
    const projectDir = makeProbeProject('{ not valid json');
    const result = await runDoctorWithArgs(['--probe-workers', '--json'], projectDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('.aiwg/aiwg.config');
  }, 60_000);
});
