/**
 * Unit tests for aiwg init handler
 *
 * @source @src/cli/handlers/init.ts
 * @implements #621
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
import { PROJECT_AIWG_LOCATION_FILE } from '../../../../src/config/project-artifacts.js';

vi.mock('../../../../src/cli/ui.js', () => ({
  blank: vi.fn(),
  rule: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  dim: vi.fn(),
  dimText: vi.fn((s: string) => s),
  bold: vi.fn((s: string) => s),
  brandMark: vi.fn(() => '◆'),
}));

// Mock readline to avoid interactive prompts in tests
vi.mock('readline', () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: vi.fn(),
      close: vi.fn(),
    })),
  },
}));

// #3062 second review, finding 5a: the `--custom-scripts` flag only matters
// on the interactive-wizard branch (`isInteractive()` true), which every
// test above this point never reaches — vitest has no real TTY, so the
// unmocked `isInteractive()` always returns `false`. Default to `false`
// here too (matching that real behavior, so every pre-existing test above
// is unaffected) and flip it to `true` only inside the dedicated describe
// block below that exercises the wizard branch itself.
const mockIsInteractive = vi.fn(() => false);
vi.mock('../../../../src/cli/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/cli/env.js')>();
  return { ...actual, isInteractive: (...callArgs: unknown[]) => mockIsInteractive(...(callArgs as [boolean?])) };
});

// Tracks whether the wizard asked anything at all. `askConsent` is passed
// through untouched (real implementation) since every new test below
// bypasses it entirely via an explicit `--worker-dispatch decline`.
const mockAskString = vi.fn(async () => '');
const mockAskYesNo = vi.fn(async (..._callArgs: unknown[]) => false);
vi.mock('../../../../src/cli/prompt-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/cli/prompt-utils.js')>();
  return {
    ...actual,
    askString: (...callArgs: unknown[]) => mockAskString(...(callArgs as Parameters<typeof actual.askString>)),
    askYesNo: (...callArgs: unknown[]) => mockAskYesNo(...(callArgs as Parameters<typeof actual.askYesNo>)),
  };
});

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'aiwg-init-test-'));
}

function makeCtx(tmpDir: string, args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: ['init', ...args],
    cwd: tmpDir,
    frameworkRoot: tmpDir,
  };
}

const ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
] as const;

function clearArtifactEnv(): Record<typeof ARTIFACT_ENV_KEYS[number], string | undefined> {
  const previous = Object.fromEntries(
    ARTIFACT_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<typeof ARTIFACT_ENV_KEYS[number], string | undefined>;
  for (const key of ARTIFACT_ENV_KEYS) delete process.env[key];
  return previous;
}

function restoreArtifactEnv(previous: Record<typeof ARTIFACT_ENV_KEYS[number], string | undefined>): void {
  for (const key of ARTIFACT_ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('initHandler', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('handler metadata', () => {
    it('has correct id and category', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      expect(initHandler.id).toBe('init');
      expect(initHandler.category).toBe('project');
    });
  });

  describe('--non-interactive mode', () => {
    it.each([true, false])('--jev decline keeps baseline init with dryRun=%s', async dryRun => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const ui = await import('../../../../src/cli/ui.js');
      const providers = ['claude', 'codex', 'muse', 'pi', 'opencode'];
      const args = ['--providers', providers.join(','), '--default-scripts', 'true',
        '--custom-scripts', 'false', '--jev', 'decline', '--worker-dispatch', 'decline', '--non-interactive'];
      if (dryRun) args.push('--dry-run');
      const result = await initHandler.execute({ ...makeCtx(tmpDir, args), dryRun });
      expect(result.exitCode).toBe(0);
      expect(result.message ?? '').not.toContain('Guided setup');
      if (dryRun) {
        expect(ui.dim).toHaveBeenCalledWith(expect.stringContaining(`Would create ${join(tmpDir, '.aiwg', 'aiwg.config')}`));
        expect(existsSync(join(tmpDir, '.aiwg'))).toBe(false);
      } else {
        const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
        expect(await readAiwgConfig(tmpDir)).toMatchObject({ providers, setup: { worker_dispatch_offer: 'declined' } });
      }
    });

    it.each([
      ['--scope', 'project', true], ['--intent', 'docs', true], ['--credential', 'codex=env:CODEX_KEY', true],
      ['--jev', 'decline', false], ['--jev', 'defer', false], ['--jev', 'enable', false],
      ['--region', 'eu', false], ['--endpoint', 'https://example.test', false],
      ['--verify', undefined, false], ['--remove', undefined, false], ['--token-stdin', undefined, false],
      ['--providers', 'claude,codex', false], ['--default-scripts', 'true', false],
      ['--custom-scripts', 'false', false], ['--script', 'check=npm test', false],
      ['--worker-dispatch', 'decline', false], ['--force', undefined, false],
      ['--non-interactive', undefined, false], ['--yes', undefined, false], ['--dry-run', undefined, false],
    ] as const)('pins guided mode selection for %s %s', async (flag, value, enabled) => {
      const { parseGuidedSetupFlags } = await import('../../../../src/cli/handlers/guided-setup.js');
      const args = value === undefined ? [flag] : [flag, value];
      expect(parseGuidedSetupFlags(args, 'init').enabled).toBe(enabled);
      if (value !== undefined) expect(parseGuidedSetupFlags([`${flag}=${value}`], 'init').enabled).toBe(enabled);
      expect(parseGuidedSetupFlags(['--', ...args], 'init').enabled).toBe(false);
      if (['--jev', '--region', '--endpoint', '--verify', '--remove', '--token-stdin'].includes(flag)) {
        expect(parseGuidedSetupFlags(args, 'setup').enabled).toBe(true);
      }
    });

    it('honors the use bootstrap context opt-out', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive', '--no-context-files']));
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(tmpDir, '.aiwg', 'aiwg.config'))).toBe(true);
      for (const name of ['WORKSPACE.md', 'AIWG.md', 'AGENTS.md', '.aiwg/AIWG.md']) {
        expect(existsSync(join(tmpDir, name))).toBe(false);
      }
    });

    it('creates config with default claude provider and default scripts', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const ctx = makeCtx(tmpDir, ['--non-interactive']);

      const result = await initHandler.execute(ctx);
      expect(result.exitCode).toBe(0);

      // Verify config was written
      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg).not.toBeNull();
      expect(cfg!.providers).toEqual(['claude']);
      expect(cfg!.scripts['deploy']).toBe('aiwg use all');
      expect(cfg!.scripts['doctor']).toBe('aiwg doctor');
      expect(cfg!.scripts['sync']).toBe('aiwg sync');

      const normalizedPath = join(tmpDir, 'AIWG.md');
      expect(existsSync(normalizedPath)).toBe(true);
      const normalized = readFileSync(normalizedPath, 'utf8');
      expect(normalized).toContain('## Context Finalization');
      // The kernel owns discovery policy; normalized context routes to it.
      expect(normalized).toContain('aiwg show rule skill-discovery');
      expect(normalized).toContain('aiwg show skill aiwg-utils-quickref');
    });

    it('keeps control files local while honoring AIWG_ARTIFACTS_PATH for the corpus', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const previousArtifactsPath = process.env['AIWG_ARTIFACTS_PATH'];
      const externalRoot = makeTmpDir();
      const artifactDir = join(externalRoot, 'corpus', '.aiwg');

      process.env['AIWG_ARTIFACTS_PATH'] = artifactDir;
      try {
        const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive']));
        expect(result.exitCode).toBe(0);

        const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
        const cfg = await readAiwgConfig(tmpDir);
        expect(cfg).not.toBeNull();
        expect(cfg!.providers).toEqual(['claude']);

        const normalizedPath = join(tmpDir, 'AIWG.md');
        expect(existsSync(normalizedPath)).toBe(true);
        expect(readFileSync(normalizedPath, 'utf8')).toContain('Generated framework context: `AIWG.md`');

        expect(existsSync(join(tmpDir, '.aiwg', 'aiwg.config'))).toBe(true);
      } finally {
        if (previousArtifactsPath === undefined) delete process.env['AIWG_ARTIFACTS_PATH'];
        else process.env['AIWG_ARTIFACTS_PATH'] = previousArtifactsPath;
        rmSync(externalRoot, { recursive: true, force: true });
      }
    });

    it('keeps control files local when .aiwg-location relocates the corpus', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const previousEnv = clearArtifactEnv();
      const externalRoot = makeTmpDir();
      const artifactDir = join(externalRoot, 'corpus', 'renamed-aiwg-store');

      writeFileSync(join(tmpDir, PROJECT_AIWG_LOCATION_FILE), `${artifactDir}\n`, 'utf-8');
      try {
        const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive']));
        expect(result.exitCode).toBe(0);

        const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
        const cfg = await readAiwgConfig(tmpDir);
        expect(cfg).not.toBeNull();
        expect(cfg!.providers).toEqual(['claude']);

        const normalizedPath = join(tmpDir, 'AIWG.md');
        expect(existsSync(normalizedPath)).toBe(true);
        expect(readFileSync(normalizedPath, 'utf8')).toContain('Generated framework context: `AIWG.md`');

        expect(existsSync(join(tmpDir, '.aiwg', 'aiwg.config'))).toBe(true);
      } finally {
        restoreArtifactEnv(previousEnv);
        rmSync(externalRoot, { recursive: true, force: true });
      }
    });

    it('--yes is an alias for --non-interactive', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const ctx = makeCtx(tmpDir, ['--yes']);

      const result = await initHandler.execute(ctx);
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg).not.toBeNull();
    });

    // #3062 second review, finding 4: `aiwg init`'s flags have no
    // pre-#3062 baseline (they were introduced by #3062 itself), so there
    // is no regression to restore — this locks in the shared parser's
    // default ('first' occurrence wins), matching this command's own
    // other flag-parsing convention (`indexOf`-style, first match).
    it('--providers repeated resolves to the first occurrence', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive', '--providers', 'codex', '--providers', 'claude']));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.providers).toEqual(['codex']);
    });
  });

  // #3062 second review, finding 5a: `--custom-scripts true|false` answers
  // "add a custom script?" directly, independent of `--script`, and fully
  // supplied input (providers + default-scripts + custom-scripts, or a
  // `--script` pair) must ask nothing at all on the interactive wizard
  // branch — the ONLY branch that ever consults `customScriptsArg` (the
  // `--non-interactive` branch above never reaches it). Every test here
  // forces `isInteractive()` true and also passes `--worker-dispatch
  // decline` so the unrelated worker-dispatch offer (which depends on
  // real-machine CLI detection) never fires and never asks anything either.
  describe('interactive wizard (terminal present): fully-supplied input asks nothing (#3062 second review, finding 5a)', () => {
    beforeEach(() => {
      mockIsInteractive.mockReturnValue(true);
      mockAskString.mockClear();
      mockAskYesNo.mockClear();
    });

    afterEach(() => {
      mockIsInteractive.mockReturnValue(false);
    });

    it('providers + default-scripts + custom-scripts all supplied: asks nothing', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, [
        '--worker-dispatch', 'decline',
        '--providers', 'codex',
        '--default-scripts', 'true',
        '--custom-scripts', 'false',
      ]));
      expect(result.exitCode).toBe(0);
      expect(mockAskString).not.toHaveBeenCalled();
      expect(mockAskYesNo).not.toHaveBeenCalled();

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.providers).toEqual(['codex']);
      expect(Object.keys(cfg!.scripts).sort()).toEqual(['deploy', 'doctor', 'sync']);
    });

    it('--script implies "add a custom script?" yes without asking it, or its name/command sub-prompts', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, [
        '--worker-dispatch', 'decline',
        '--providers', 'codex',
        '--default-scripts', 'false',
        '--script', 'lint=npm run lint',
      ]));
      expect(result.exitCode).toBe(0);
      expect(mockAskString).not.toHaveBeenCalled();
      expect(mockAskYesNo).not.toHaveBeenCalled();

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.scripts).toEqual({ lint: 'npm run lint' });
    });

    it('--custom-scripts false (no --script) declines the question without ever asking it', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, [
        '--worker-dispatch', 'decline',
        '--providers', 'codex',
        '--default-scripts', 'true',
        '--custom-scripts', 'false',
      ]));
      expect(result.exitCode).toBe(0);
      expect(mockAskYesNo).not.toHaveBeenCalled();

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(Object.keys(cfg!.scripts).sort()).toEqual(['deploy', 'doctor', 'sync']);
    });

    it('--custom-scripts true (no --script) still asks for the name/command — only the yes/no is answered', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      mockAskString.mockImplementation(async (..._callArgs: unknown[]) => '');
      const result = await initHandler.execute(makeCtx(tmpDir, [
        '--worker-dispatch', 'decline',
        '--providers', 'codex',
        '--default-scripts', 'true',
        '--custom-scripts', 'true',
      ]));
      expect(result.exitCode).toBe(0);
      // The yes/no question itself is answered by the flag, not asked —
      // only the two follow-up sub-prompts (name, command) are asked.
      expect(mockAskYesNo).not.toHaveBeenCalled();
      expect(mockAskString).toHaveBeenCalledTimes(2);
    });
  });

  describe('existing config', () => {
    it('exits 0 and reports existing config without overwriting', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');

      // First init
      const ctx = makeCtx(tmpDir, ['--non-interactive']);
      await initHandler.execute(ctx);

      // Second init without --force
      const result = await initHandler.execute(ctx);
      expect(result.exitCode).toBe(0);

      // Config should still have the original content
      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.providers).toEqual(['claude']);
    });

    it('repairs missing root AIWG.md when config already exists', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');

      await initHandler.execute(makeCtx(tmpDir, ['--non-interactive']));
      rmSync(join(tmpDir, 'AIWG.md'), { force: true });

      const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive']));
      expect(result.exitCode).toBe(0);

      const normalizedPath = join(tmpDir, 'AIWG.md');
      expect(existsSync(normalizedPath)).toBe(true);
      expect(readFileSync(normalizedPath, 'utf8')).toContain('## Context Finalization');
    });

    it('--force overwrites existing config', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');

      // First init
      await initHandler.execute(makeCtx(tmpDir, ['--non-interactive']));

      // Second init with --force
      const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive', '--force']));
      expect(result.exitCode).toBe(0);
    });
  });
});
