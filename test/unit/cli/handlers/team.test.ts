/**
 * Unit tests for team.ts handler
 * Covers run, list, info subcommands.
 *
 * @issue #691
 * @parent #684
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
import { listProviderDefinitions } from '../../../../src/providers/provider-definitions.js';

// ── Mocks ────────────────────────────────────────────────────

vi.mock('../../../../src/cli/ui.js', () => ({
  blank: vi.fn(),
  rule: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  dim: vi.fn(),
  bold: vi.fn((s: string) => s),
  brandMark: vi.fn(() => '◆'),
  dimText: vi.fn((s: string) => s),
  header: vi.fn(),
  accent: vi.fn((s: string) => s),
  error: vi.fn(),
}));

import { teamHandler } from '../../../../src/cli/handlers/team.js';

// ── Test data ─────────────────────────────────────────────────

const sampleTeam = {
  name: 'SDLC Review',
  slug: 'sdlc-review',
  description: 'Core SDLC review team',
  agents: [
    { agent: 'requirements-analyst', role: 'lead', responsibilities: ['Analyze requirements'] },
    { agent: 'test-architect', role: 'reviewer', responsibilities: ['Review test coverage'] },
  ],
  dispatch: 'sequential' as const,
  sdlc_phases: ['elaboration', 'construction'],
};

// ── Helpers ───────────────────────────────────────────────────

let tmpDir: string;
let teamsDir: string;
let frameworkRoot: string;

function makeCtx(args: string[] = {}): HandlerContext {
  return {
    args: args as unknown as string[],
    rawArgs: ['team', ...(args as unknown as string[])],
    cwd: tmpDir,
    frameworkRoot,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aiwg-team-test-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'aiwg-team-fw-'));
  teamsDir = join(tmpDir, '.aiwg', 'teams');
  mkdirSync(teamsDir, { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(frameworkRoot, { recursive: true, force: true });
});

function writeTeam(slug: string, team = sampleTeam): void {
  writeFileSync(join(teamsDir, `${slug}.json`), JSON.stringify(team));
}

// ── teamHandler metadata ──────────────────────────────────────

describe('teamHandler metadata', () => {
  it('has correct id and category', () => {
    expect(teamHandler.id).toBe('team');
    expect(teamHandler.category).toBe('orchestration');
    expect(teamHandler.aliases).toContain('teams');
    expect(typeof teamHandler.execute).toBe('function');
  });
});

// ── No subcommand / help ──────────────────────────────────────

describe('team (no subcommand)', () => {
  it('shows help and exits 0', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await teamHandler.execute(makeCtx([]));
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('unknown subcommand exits 1', async () => {
    const result = await teamHandler.execute(makeCtx(['bogus']));
    expect(result.exitCode).toBe(1);
  });
});

// ── team list ────────────────────────────────────────────────

describe('team list', () => {
  it('exits 0 when no teams found (graceful)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await teamHandler.execute(makeCtx(['list']));
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('exits 0 and lists teams when teams exist', async () => {
    writeTeam('sdlc-review');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await teamHandler.execute(makeCtx(['list']));
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('--json outputs parseable JSON array', async () => {
    writeTeam('sdlc-review');
    const jsonLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((s) => jsonLines.push(String(s)));
    await teamHandler.execute(makeCtx(['list', '--json']));
    consoleSpy.mockRestore();
    const jsonOutput = jsonLines.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty('slug', 'sdlc-review');
  });
});

// ── team info ────────────────────────────────────────────────

describe('team info', () => {
  it('exits 1 when no slug given', async () => {
    const result = await teamHandler.execute(makeCtx(['info']));
    expect(result.exitCode).toBe(1);
  });

  it('exits 1 when team not found', async () => {
    const result = await teamHandler.execute(makeCtx(['info', 'nonexistent']));
    expect(result.exitCode).toBe(1);
  });

  it('exits 0 and shows team info for known team', async () => {
    writeTeam('sdlc-review');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await teamHandler.execute(makeCtx(['info', 'sdlc-review']));
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('--json outputs parseable JSON with team fields', async () => {
    writeTeam('sdlc-review');
    const jsonLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((s) => jsonLines.push(String(s)));
    await teamHandler.execute(makeCtx(['info', 'sdlc-review', '--json']));
    consoleSpy.mockRestore();
    const jsonOutput = jsonLines.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed).toHaveProperty('name', 'SDLC Review');
    expect(parsed).toHaveProperty('agents');
  });
});

// ── team run ─────────────────────────────────────────────────

describe('team run', () => {
  it('exits 1 when no slug given', async () => {
    const result = await teamHandler.execute(makeCtx(['run']));
    expect(result.exitCode).toBe(1);
  });

  it('exits 1 when team not found', async () => {
    const result = await teamHandler.execute(makeCtx(['run', 'nonexistent']));
    expect(result.exitCode).toBe(1);
  });

  it('exits 0 for known team with --provider override (mc emulation)', async () => {
    writeTeam('sdlc-review');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await teamHandler.execute(makeCtx(['run', 'sdlc-review', '--provider', 'cursor']));
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  // Provider auto-detection now goes through the shared `resolveActiveProvider`
  // path (#2623, #2627, #3054) instead of an ad-hoc
  // CLAUDE_CODE_VERSION/ANTHROPIC_API_KEY check, so this must be hermetic
  // against whatever Claude-Code-shaped env vars the host running this suite
  // happens to have set (this suite may itself be invoked from inside a live
  // Claude Code session).
  describe('provider auto-detection (#3054)', () => {
    const PROVIDER_ENV_KEYS = Array.from(
      new Set(['CLAUDE_CODE_VERSION', 'ANTHROPIC_API_KEY', ...listProviderDefinitions().flatMap((d) => d.detection.env)]),
    );
    const saved = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const key of PROVIDER_ENV_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
      }
      // Deterministic: don't let process ancestry (which may genuinely be
      // Claude Code, since that's what's running this test) decide.
      process.env.AIWG_DISABLE_PROCESS_PROVIDER_DETECTION = '1';
    });

    afterEach(() => {
      for (const key of PROVIDER_ENV_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      saved.clear();
      delete process.env.AIWG_DISABLE_PROCESS_PROVIDER_DETECTION;
    });

    it('dispatches natively when current Claude Code markers are present', async () => {
      process.env.CLAUDECODE = '1';
      process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
      writeTeam('sdlc-review', { ...sampleTeam, agents: [{ agent: 'fixture-coder', role: 'contributor', responsibilities: [] }] });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await teamHandler.execute(makeCtx(['run', 'sdlc-review']));
        expect(result.exitCode).toBe(0);
        expect(log.mock.calls.flat().join('\n')).toContain('Native team dispatch (Claude Code)');
      } finally {
        log.mockRestore();
      }
    });

    it('does not dispatch natively from ANTHROPIC_API_KEY alone (false-positive fix)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-not-actually-claude-code';
      writeTeam('sdlc-review');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await teamHandler.execute(makeCtx(['run', 'sdlc-review']));
        expect(result.exitCode).toBe(0);
        expect(log.mock.calls.flat().join('\n')).toContain('Team dispatch via Mission Control (aiwg mc)');
      } finally {
        log.mockRestore();
      }
    });

    it('falls back to mc emulation when neither stale nor current markers are present', async () => {
      writeTeam('sdlc-review');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await teamHandler.execute(makeCtx(['run', 'sdlc-review']));
        expect(result.exitCode).toBe(0);
        expect(log.mock.calls.flat().join('\n')).toContain('Team dispatch via Mission Control (aiwg mc)');
      } finally {
        log.mockRestore();
      }
    });
  });
});


describe('OMP public team execution', () => {
  function runtimeFixture() {
    const runtimeDir = join(frameworkRoot, 'tools', 'providers');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'omp-teams.mjs'), `import { writeFileSync } from 'node:fs';
export async function runOmpTeam(options) { writeFileSync(${JSON.stringify(join(tmpDir, 'omp-invocation.json'))}, JSON.stringify({ ...options, hasSignal: Boolean(options.signal) })); return { provider: 'omp', results: options.tasks.map(task => ({ id: task.id, status: task.fail ? 'failed' : 'completed' })) }; }
`);
  }
  it.each(['omp', 'oh-my-pi'])('routes %s to the bounded native runner with explicit paths, model, profile and signal', async provider => {
    runtimeFixture();
    const tasks = [{ id: 'research', agent: 'researcher', prompt: 'inspect', tools: ['read'], ownership: ['findings.md'] }];
    writeFileSync(join(tmpDir, 'tasks.json'), JSON.stringify({ tasks }));
    const before = process.listenerCount('SIGINT');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await teamHandler.execute(makeCtx(['run', '--provider', provider, '--body-file', 'tasks.json', '--cwd', 'work', '--output-root', 'results', '--max-parallel', '2', '--model', 'fixture/model', '--profile', 'review']));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(tmpDir, 'omp-invocation.json'), 'utf8'))).toMatchObject({ tasks, cwd: join(tmpDir, 'work'), outputDir: join(tmpDir, 'results'), maxParallel: 2, model: 'fixture/model', profile: 'review', hasSignal: true });
      expect(process.listenerCount('SIGINT')).toBe(before);
      expect(log.mock.calls.flat().join(' ')).not.toContain('Mission Control');
    } finally { log.mockRestore(); }
  });
  it('propagates native worker failure through the public command exit code', async () => {
    runtimeFixture(); writeFileSync(join(tmpDir, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'failed', fail: true }] }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect((await teamHandler.execute(makeCtx(['run', '--provider', 'omp', '--body-file', 'tasks.json']))).exitCode).toBe(1); }
    finally { log.mockRestore(); }
  });
  it.each([
    ['run', '--provider', 'omp'],
    ['run', '--provider', 'omp', '--body-file', 'tasks.json', '--max-parallel', '0'],
    ['run', '--provider', 'omp', '--body-file', 'tasks.json', '--unexpected'],
  ])('rejects incomplete OMP controls before dispatch: %j', async (...args) => {
    expect((await teamHandler.execute(makeCtx(args))).exitCode).toBe(1);
  });
});
