/**
 * Unit tests for help.ts handler
 *
 * @issue #691
 * @parent #684
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

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
  channelLabel: vi.fn((s: string) => `[${s}]`),
}));

import { helpHandler } from '../../../../src/cli/handlers/help.js';
import { getCommandIds } from '../../../../src/extensions/commands/definitions.js';

afterEach(() => vi.restoreAllMocks());

// ── Helpers ───────────────────────────────────────────────────

function makeCtx(args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: ['help', ...args],
    cwd: '/mock/cwd',
    frameworkRoot: '/mock/framework/root',
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe('helpHandler metadata', () => {
  it('has correct id and category', () => {
    expect(helpHandler.id).toBe('help');
    expect(helpHandler.category).toBe('maintenance');
    expect(typeof helpHandler.execute).toBe('function');
  });

  it('includes -h, -help, --help aliases', () => {
    expect(helpHandler.aliases).toContain('-h');
    expect(helpHandler.aliases).toContain('-help');
    expect(helpHandler.aliases).toContain('--help');
  });
});

describe('helpHandler.execute', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('emits only the versioned canonical command registry for --json', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await helpHandler.execute(makeCtx(['--json']));
    expect(result.exitCode).toBe(0);
    expect(output).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(output.mock.calls[0][0]);
    expect(payload).toEqual({ schema: 'aiwg.command-registry.v1', commandIds: getCommandIds() });
    expect(payload.commandIds).toContain('mc');
    expect(payload.commandIds).not.toContain('aiwg');
    expect(new Set(payload.commandIds).size).toBe(payload.commandIds.length);
    const { header, blank, rule } = await import('../../../../src/cli/ui.js');
    expect(header).not.toHaveBeenCalled();
    expect(blank).not.toHaveBeenCalled();
    expect(rule).not.toHaveBeenCalled();
  });

  it('exits 0', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await helpHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('prints help output to stdout', async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((s) => output.push(String(s ?? '')));
    await helpHandler.execute(makeCtx());
    expect(output.length).toBeGreaterThan(0);
    consoleSpy.mockRestore();
  });

  it('includes major command categories', async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((s) => output.push(String(s ?? '')));
    const { header } = await import('../../../../src/cli/ui.js');
    await helpHandler.execute(makeCtx());
    consoleSpy.mockRestore();

    // header() is called once per command group
    const headerCalls = (header as ReturnType<typeof vi.fn>).mock.calls.map(([s]: [string]) => s);
    const allGroups = headerCalls.join(' ');
    expect(allGroups).toMatch(/FRAMEWORK/i);
    expect(allGroups).toMatch(/WORKSPACE/i);
    expect(allGroups).toMatch(/MAINTENANCE/i);
    expect(allGroups).toMatch(/RALPH/i);
  });

  it('includes key commands in output (use, doctor, version, ralph)', async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((s) => output.push(String(s ?? '')));
    await helpHandler.execute(makeCtx());
    consoleSpy.mockRestore();
    const combined = output.join('\n');
    // These commands must appear in help output
    expect(combined).toMatch(/use/);
    expect(combined).toMatch(/doctor/);
    expect(combined).toMatch(/version/);
    expect(combined).toMatch(/ralph/);
    expect(combined).toMatch(/sessions <command>.*normalized session catalog/);
  });

  it('includes provider list', async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((s) => output.push(String(s ?? '')));
    await helpHandler.execute(makeCtx());
    consoleSpy.mockRestore();
    const combined = output.join('\n');
    expect(combined).toMatch(/claude/i);
    expect(combined).toMatch(/copilot/i);
  });
});
