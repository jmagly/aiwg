/**
 * Unit tests for the direct-worker dispatch opt-in hint inside `aiwg
 * refresh` (#3050 item 4, and review item 7's "missing assertion").
 *
 * Detection is mocked so these tests never depend on which worker CLIs the
 * running host actually has installed — unlike the existing
 * `regenerates ... for codex` style tests in `refresh.test.ts`, which
 * observed the real host's detected CLIs incidentally.
 *
 * @source @src/cli/handlers/refresh.ts
 * @implements #3050
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
import { refreshHandler } from '../../../../src/cli/handlers/refresh.js';
import { getFrameworkRoot } from '../../../../src/channel/manager.mjs';

const detected = vi.hoisted(() => ({ clis: [] as string[] }));

const {
  mockRun, mockUseExecute, mockRefreshAllPackages, mockReadAiwgConfig, mockHashManifest,
  mockWriteAiwgConfig,
} = vi.hoisted(() => ({
  mockRun: vi.fn().mockResolvedValue({ exitCode: 0 }),
  mockUseExecute: vi.fn().mockResolvedValue({ exitCode: 0 }),
  mockRefreshAllPackages: vi.fn().mockResolvedValue([]),
  mockReadAiwgConfig: vi.fn().mockResolvedValue(null),
  mockHashManifest: vi.fn().mockResolvedValue(null),
  mockWriteAiwgConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(() => ({ run: mockRun })),
}));

vi.mock('../../../../src/cli/handlers/use.js', () => ({
  createUseHandler: vi.fn(() => ({ execute: mockUseExecute })),
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn().mockResolvedValue('/mock/framework/root'),
}));

vi.mock('../../../../src/packages/registry.js', () => ({
  refreshAllPackages: mockRefreshAllPackages,
}));

vi.mock('../../../../src/config/aiwg-config.js', () => ({
  readAiwgConfig: mockReadAiwgConfig,
  hashManifest: mockHashManifest,
  writeAiwgConfig: mockWriteAiwgConfig,
  getProviderParallelismDefaults: vi.fn(() => ({
    max_parallel_subagents: 4, max_parallel_ralph_loops: 2, max_parallel_mc_missions: 4,
  })),
}));

vi.mock('../../../../src/models/worker-dispatch-offer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/models/worker-dispatch-offer.js')>();
  return { ...actual, detectInstalledWorkerClis: vi.fn(() => detected.clis) };
});

const uiMocks = vi.hoisted(() => ({
  blank: vi.fn(), rule: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  bold: vi.fn((s: string) => s), brandMark: vi.fn(() => '◆'), dimText: vi.fn((s: string) => s),
  header: vi.fn(), accent: vi.fn((s: string) => s), error: vi.fn(), channelLabel: vi.fn((s: string) => `[${s}]`),
}));
vi.mock('../../../../src/cli/ui.js', () => uiMocks);

function makeCtx(args: string[] = []): HandlerContext {
  return { args, rawArgs: ['refresh', ...args], cwd: '/mock/cwd', frameworkRoot: '/mock/framework/root' };
}

const savedProcessProvider = process.env.AIWG_TEST_PROCESS_PROVIDER;

describe('aiwg refresh — worker dispatch opt-in hint (#3050)', () => {
  beforeEach(() => {
    vi.mocked(getFrameworkRoot).mockResolvedValue('/mock/framework/root');
    process.env.AIWG_TEST_PROCESS_PROVIDER = 'codex';
    detected.clis = [];
    mockRun.mockResolvedValue({ exitCode: 0 });
    mockUseExecute.mockResolvedValue({ exitCode: 0 });
    mockRefreshAllPackages.mockResolvedValue([]);
    mockReadAiwgConfig.mockResolvedValue({ providers: ['codex'], installed: {}, parallelism: {} });
    for (const fn of Object.values(uiMocks)) if ('mockClear' in fn) (fn as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    if (savedProcessProvider === undefined) delete process.env.AIWG_TEST_PROCESS_PROVIDER;
    else process.env.AIWG_TEST_PROCESS_PROVIDER = savedProcessProvider;
  });

  it('prints the hint when dispatch is off and two or more worker CLIs are detected', async () => {
    detected.clis = ['codex', 'muse'];
    const result = await refreshHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);
    expect(uiMocks.info).toHaveBeenCalledWith(expect.stringContaining('aiwg config set --project parallelism.worker_dispatch true'));
  });

  it('prints nothing when only one worker CLI is detected', async () => {
    detected.clis = ['codex'];
    await refreshHandler.execute(makeCtx());
    expect(uiMocks.info).not.toHaveBeenCalledWith(expect.stringContaining('worker_dispatch'));
  });

  it('prints nothing once dispatch is already on', async () => {
    detected.clis = ['codex', 'muse'];
    mockReadAiwgConfig.mockResolvedValue({ providers: ['codex'], installed: {}, parallelism: { worker_dispatch: true } });
    await refreshHandler.execute(makeCtx());
    expect(uiMocks.info).not.toHaveBeenCalledWith(expect.stringContaining('worker_dispatch'));
  });

  // #3050 fix-first: the decline lives in `setup` (a plain onboarding
  // preference), not in `parallelism` (the frozen B-OG-29 contract fragment).
  it('prints nothing once a decline was recorded', async () => {
    detected.clis = ['codex', 'muse'];
    mockReadAiwgConfig.mockResolvedValue({ providers: ['codex'], installed: {}, parallelism: {}, setup: { worker_dispatch_offer: 'declined' } });
    await refreshHandler.execute(makeCtx());
    expect(uiMocks.info).not.toHaveBeenCalledWith(expect.stringContaining('worker_dispatch'));
  });

  it('prints nothing under --quiet, even when the offer would otherwise apply', async () => {
    detected.clis = ['codex', 'muse'];
    const result = await refreshHandler.execute(makeCtx(['--quiet']));
    expect(result.exitCode).toBe(0);
    expect(uiMocks.info).not.toHaveBeenCalledWith(expect.stringContaining('worker_dispatch'));
  });
});
