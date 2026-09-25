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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DOCTOR_SCRIPT = resolve(__dirname, '../../../tools/cli/doctor.mjs');

// Mock channel manager — same pattern as doctor-channel.test.ts
const mockGetFrameworkRoot = vi.fn();
const mockGetVersionInfo = vi.fn();

vi.mock('../../../src/channel/manager.mjs', () => ({
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
  function checkNodeVersion(version: string) {
    const major = parseInt(version.slice(1).split('.')[0]);
    if (major >= 18) {
      return { status: 'ok' as const, message: version };
    } else {
      return { status: 'error' as const, message: `${version} (requires >= 18.0.0)` };
    }
  }

  it('ok for Node 18', () => {
    expect(checkNodeVersion('v18.0.0').status).toBe('ok');
  });

  it('ok for Node 22', () => {
    expect(checkNodeVersion('v22.1.0').status).toBe('ok');
  });

  it('error for Node 16', () => {
    const result = checkNodeVersion('v16.20.0');
    expect(result.status).toBe('error');
    expect(result.message).toContain('requires >= 18');
  });
});

// ── MCP server check logic ────────────────────────────────────

describe('doctor: MCP server check', () => {
  async function checkMcp(root: string, exists: (p: string) => Promise<boolean>) {
    const mcpServer = `${root}/src/mcp/server.mjs`;
    const present = await exists(mcpServer);
    return present
      ? { status: 'ok' as const, message: 'Available (run: aiwg mcp serve)' }
      : { status: 'warn' as const, message: 'Not found' };
  }

  it('ok when mcp server exists', async () => {
    const result = await checkMcp('/root', async () => true);
    expect(result.status).toBe('ok');
  });

  it('warn (not error) when mcp server absent', async () => {
    const result = await checkMcp('/root', async () => false);
    expect(result.status).toBe('warn');
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
    expect(content).toContain("a === '--strict-context'");
    expect(content).toContain("a === '--context-baseline'");
    expect(content).toContain("a === '--context-budget-tokens'");
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
    expect(content).toMatch(/'grokbot', 'muse'\]/);
    expect(content).toMatch(/provName === 'muse' && \(providerArg \|\| allProviders\)/);
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
