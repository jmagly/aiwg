import { mkdtempSync } from '../../../helpers/temp-dir.js';
import { writeExecutableSync } from '../../../helpers/write-executable.js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

// Defaults to `false` (no terminal), matching the real `isInteractive()`
// under Vitest (no TTY attached) that every pre-existing test in this file
// already implicitly relies on. The dedicated `interactive: true`/`ask`
// terminal-present tests below (#3062 second review, finding 5b) override
// this per test.
const mockIsInteractive = vi.fn(() => false);
vi.mock('../../../../src/cli/env.js', () => ({ isInteractive: (...callArgs: unknown[]) => mockIsInteractive(...callArgs) }));

// A queue-based fake for the `ask`-step interactive-prompt path: each
// `askString` call shifts the next queued answer (or '' once exhausted).
const promptAnswerQueue: string[] = [];
const mockAskString = vi.fn(async () => (promptAnswerQueue.length > 0 ? promptAnswerQueue.shift()! : ''));
vi.mock('../../../../src/cli/prompt-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/cli/prompt-utils.js')>();
  return {
    ...actual,
    askString: (...callArgs: unknown[]) => mockAskString(...callArgs),
    createPromptInterface: () => ({ close: () => {} }),
  };
});

import {
  generateSetupManifest,
  runSetupManifest,
  setupGenerateHandler,
  setupRunHandler,
  setupValidateHandler,
  validateSetupManifest,
} from '../../../../src/cli/handlers/setup-manifest.js';
import { allHandlers } from '../../../../src/cli/handlers/index.js';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

// `config/vitest.config.js` sets `mockReset: true`, which wipes a mock's
// implementation (including the one passed to `vi.fn(impl)` at creation)
// before every test — re-establish both explicitly rather than relying on
// the module-level factory surviving that reset.
beforeEach(() => {
  mockIsInteractive.mockReturnValue(false);
  promptAnswerQueue.length = 0;
  mockAskString.mockClear();
  mockAskString.mockImplementation(async () => (promptAnswerQueue.length > 0 ? promptAnswerQueue.shift()! : ''));
});

afterEach(() => {
  mockIsInteractive.mockReturnValue(false);
  promptAnswerQueue.length = 0;
});

function ctx(tmpDir: string, args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: args,
    cwd: tmpDir,
    frameworkRoot: REPO_ROOT,
  };
}

function writeExecutable(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeExecutableSync(filePath, body);
}

function writeManifest(tmpDir: string, manifest: Record<string, unknown>, name = 'setup.manifest.yaml'): string {
  const manifestPath = path.join(tmpDir, name);
  fs.writeFileSync(manifestPath, stringify(manifest), 'utf8');
  return manifestPath;
}

function baseManifest(step: Record<string, unknown> = { id: 'install', type: 'script', script: 'scripts/install.sh' }) {
  return {
    apiVersion: 'setup.aiwg.io/v1',
    kind: 'SetupManifest',
    metadata: {
      name: 'sample',
      description: 'no os configuration required',
      install_type: 'developer',
    },
    spec: {
      platforms: [{ os: 'linux' }],
      params: [
        { name: 'INSTALL_DIR', type: 'path', interactive_required: true },
      ],
      steps: [step],
    },
  };
}

describe('setup manifest CLI handlers', () => {
  let tmpDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-setup-manifest-'));
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers setup manifest commands as agent-facing CLI handlers', () => {
    const ids = new Set(allHandlers.map((handler) => handler.id));
    expect([...ids]).toEqual(expect.arrayContaining(['setup-generate', 'setup-validate', 'setup-run']));
  });

  it('prints help for setup-generate, setup-validate, and setup-run', async () => {
    await expect(setupGenerateHandler.execute(ctx(tmpDir, ['--help']))).resolves.toMatchObject({ exitCode: 0 });
    await expect(setupValidateHandler.execute(ctx(tmpDir, ['--help']))).resolves.toMatchObject({ exitCode: 0 });
    await expect(setupRunHandler.execute(ctx(tmpDir, ['--help']))).resolves.toMatchObject({ exitCode: 0 });
    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join('\n');
    expect(output).toContain('aiwg setup-generate');
    expect(output).toContain('aiwg setup-validate');
    expect(output).toContain('aiwg setup-run');
    expect(output).toContain('--json');
    expect(output).toContain('--dry-run');
  });

  it('generates a starter manifest that validates', () => {
    const result = generateSetupManifest({
      cwd: tmpDir,
      output: 'installer/setup.dev.manifest.yaml',
      name: 'generated-project',
      type: 'developer',
      platform: 'linux',
    });

    expect(result.exitCode).toBe(0);
    const validation = validateSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      manifestPath: 'installer/setup.dev.manifest.yaml',
    });
    expect(validation.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('does not treat setup-generate option values as positional output paths', async () => {
    await expect(setupGenerateHandler.execute(ctx(tmpDir, ['--name', 'named-project']))).resolves.toMatchObject({
      exitCode: 0,
    });

    expect(fs.existsSync(path.join(tmpDir, 'setup.manifest.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'named-project'))).toBe(false);
  });

  it('validates a correct manifest and rejects malformed or missing manifests', () => {
    writeExecutable(path.join(tmpDir, 'scripts/install.sh'), '#!/usr/bin/env sh\nexit 0\n');
    writeManifest(tmpDir, baseManifest());

    expect(validateSetupManifest({ cwd: tmpDir, frameworkRoot: REPO_ROOT }).findings).toEqual([]);

    fs.writeFileSync(path.join(tmpDir, 'broken.yaml'), 'apiVersion: [unterminated\n', 'utf8');
    expect(validateSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      manifestPath: 'broken.yaml',
    }).findings[0]).toMatchObject({ severity: 'error', rule: 'yaml' });

    expect(validateSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      manifestPath: 'missing.yaml',
    }).findings[0]).toMatchObject({ severity: 'error', rule: 'manifestExists' });
  });

  it('reports schema and installer consistency failures with paths and rule names', () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['schema.yaml', { ...baseManifest(), kind: 'Other' }, '/kind', 'const'],
      ['missing-script.yaml', baseManifest({ id: 'install', type: 'script', script: 'scripts/missing.sh' }), '/spec/steps/0/script', 'scriptExists'],
      ['depends.yaml', baseManifest({ id: 'install', type: 'verify', commands: ['true'], depends_on: ['missing'] }), '/spec/steps/0/depends_on', 'depends_on'],
      ['recovery.yaml', baseManifest({ id: 'install', type: 'verify', commands: ['false'], on_fail: 'missing' }), '/spec/steps/0/on_fail', 'on_fail'],
      ['chain.yaml', baseManifest({ id: 'chain', type: 'chain', manifest: 'missing.yaml' }), '/spec/steps/0/manifest', 'chainManifestExists'],
      ['agentic.yaml', baseManifest({ id: 'manual', type: 'agentic' }), '/spec/steps/0/instruction', 'agenticInstruction'],
    ];

    for (const [fileName, manifest, expectedPath, expectedRule] of cases) {
      writeManifest(tmpDir, manifest, fileName);
      const findings = validateSetupManifest({
        cwd: tmpDir,
        frameworkRoot: REPO_ROOT,
        manifestPath: fileName,
      }).findings;
      expect(findings, fileName).toContainEqual(expect.objectContaining({
        severity: 'error',
        path: expectedPath,
        rule: expectedRule,
      }));
    }
  });

  // Go/no-go review blocker 3: a recovery procedure referencing itself (or
  // another recovery that references back) is a clean validation error —
  // the `RangeError: Maximum call stack size exceeded` the review
  // reproduced — not a crash. `detectRecoveryReferenceCycles()`'s own doc
  // comment explains why this is a bounded graph walk, not a recursive
  // preflight.
  it.each([
    {
      label: 'a recovery procedure whose own step on_fails back to itself',
      recovery: [{
        id: 'recover-install',
        steps: [{ id: 'retry', type: 'verify', commands: ['false'], on_fail: 'recover-install' }],
      }],
    },
    {
      label: 'two recovery procedures that on_fail into each other',
      recovery: [
        { id: 'recover-a', steps: [{ id: 'retry-a', type: 'verify', commands: ['false'], on_fail: 'recover-b' }] },
        { id: 'recover-b', steps: [{ id: 'retry-b', type: 'verify', commands: ['false'], on_fail: 'recover-a' }] },
      ],
    },
  ])('reports a clean recoveryCycle error, not a crash, for $label', ({ recovery }) => {
    const manifest = baseManifest({ id: 'install', type: 'verify', commands: ['false'], on_fail: recovery[0]!.id });
    (manifest.spec as Record<string, unknown>).recovery = recovery;
    writeManifest(tmpDir, manifest, 'recovery-cycle.yaml');

    const findings = validateSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      manifestPath: 'recovery-cycle.yaml',
    }).findings;

    expect(findings).toContainEqual(expect.objectContaining({
      severity: 'error',
      path: '/spec/recovery',
      rule: 'recoveryCycle',
    }));
    // Exactly one finding per distinct cycle — not one per node visited,
    // which would otherwise silently reveal an unbounded walk.
    expect(findings.filter((finding) => finding.rule === 'recoveryCycle')).toHaveLength(1);
  });

  it('uses shared repeatable parameter parsing, preserves last override and empty values', async () => {
    writeExecutable(path.join(tmpDir, 'scripts/install.sh'), '#!/bin/sh\nexit 0\n');
    writeManifest(tmpDir, baseManifest());
    const result = await setupRunHandler.execute(ctx(tmpDir, [
      '--manifest=setup.manifest.yaml', '--platform=linux', '--dry-run',
      '--param=INSTALL_DIR=first', '--set', 'INSTALL_DIR=last', '--param=EXTRA=',
    ]));
    expect(result.exitCode).toBe(0);
    expect(stdoutSpy.mock.calls.flat().join('')).toContain('INSTALL_DIR=last');
  });

  it.each([['--param'], ['--param=INSTALL_DIR=ok', '--param'], ['--set', '--yes']].map(args => ({ args })))('rejects malformed repeatable flags before execution: $args', async ({ args }) => {
    const result = await setupRunHandler.execute(ctx(tmpDir, args));
    expect(result.exitCode).toBe(2);
    expect(mockAskString).not.toHaveBeenCalled();
  });

  it('does not treat parameter values or tokens after -- as confirmation switches', async () => {
    writeExecutable(path.join(tmpDir, 'scripts/install.sh'), '#!/bin/sh\nexit 0\n');
    writeManifest(tmpDir, baseManifest());
    for (const suffix of [['--param', '--yes'], ['--', '--yes', '--dry-run']]) {
      const result = await setupRunHandler.execute(ctx(tmpDir, ['--manifest', 'setup.manifest.yaml', '--platform', 'linux', '--param=INSTALL_DIR=ok', ...suffix]));
      expect(result.exitCode).toBe(2);
    }
  });

  it('dry-runs a valid manifest without executing steps', async () => {
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts/install.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    writeManifest(tmpDir, baseManifest());

    const result = await runSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      dryRun: true,
      platform: 'linux',
      paramValues: { INSTALL_DIR: tmpDir },
      skip: new Set(),
    });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join('\n')).toContain('[setup:dry-run]');
  });

  it('blocks provider-orchestrated handoff until the exact manifest bytes are verified', async () => {
    const manifest = baseManifest({ id: 'inspect', type: 'agentic', instruction: 'Inspect the project safely.' });
    manifest.metadata.execution_mode = 'provider-orchestrated';
    writeManifest(tmpDir, manifest);

    const validation = validateSetupManifest({ cwd: tmpDir, frameworkRoot: REPO_ROOT });
    expect(validation.findings.filter((finding) => finding.rule === 'agenticStep')).toEqual([]);
    expect(await runSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      platform: 'linux',
      paramValues: { INSTALL_DIR: tmpDir },
      skip: new Set(),
      yes: true,
    })).toMatchObject({
      exitCode: 29,
      message: expect.stringContaining('handoff blocked'),
    });

    const manifestPath = path.join(tmpDir, 'setup.manifest.yaml');
    const bytes = fs.readFileSync(manifestPath);
    expect(await runSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      platform: 'linux',
      paramValues: { INSTALL_DIR: tmpDir },
      skip: new Set(),
      yes: true,
      artifactVerification: {
        schemaVersion: 'aiwg.verify.result.v1',
        status: 'verified',
        exitCode: 0,
        artifact: { name: 'setup.manifest.yaml', sha256: createHash('sha256').update(bytes).digest('hex') },
        identities: ['release'],
        diagnostics: [],
      },
    })).toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('verified provider-orchestrated manifest'),
    });
  });

  it('fails invalid manifests and missing params before execution', async () => {
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts/install.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    writeManifest(tmpDir, { ...baseManifest(), kind: 'Other' });
    expect((await runSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      platform: 'linux',
      paramValues: { INSTALL_DIR: tmpDir },
      skip: new Set(),
      yes: true,
    })).exitCode).toBe(1);
    expect(fs.existsSync(marker)).toBe(false);

    writeManifest(tmpDir, baseManifest());
    expect((await runSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      platform: 'linux',
      paramValues: {},
      skip: new Set(),
      yes: true,
    })).exitCode).toBe(1);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses mutating execution without confirmation and runs successfully with confirmation', async () => {
    const installDir = path.join(tmpDir, 'install-target');
    const marker = path.join(installDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts/install.sh'), '#!/usr/bin/env sh\nmkdir -p "$INSTALL_DIR"\nprintf ran > "$INSTALL_DIR/marker"\n');
    writeManifest(tmpDir, baseManifest());

    expect((await runSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      platform: 'linux',
      paramValues: { INSTALL_DIR: installDir },
      skip: new Set(),
      yes: false,
    })).exitCode).toBe(2);
    expect(fs.existsSync(marker)).toBe(false);

    expect((await runSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      platform: 'linux',
      paramValues: { INSTALL_DIR: installDir },
      skip: new Set(),
      yes: true,
    })).exitCode).toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('ran');
  });

  it('runs recovery deterministically and preserves nonzero status after failed step', async () => {
    const recoveryMarker = path.join(tmpDir, 'recovered');
    writeExecutable(path.join(tmpDir, 'scripts/fail.sh'), '#!/usr/bin/env sh\nexit 7\n');
    writeExecutable(path.join(tmpDir, 'scripts/recover.sh'), `#!/usr/bin/env sh\nprintf recovered > ${recoveryMarker}\n`);
    writeManifest(tmpDir, {
      ...baseManifest({ id: 'install', type: 'script', script: 'scripts/fail.sh', on_fail: 'recover-install' }),
      spec: {
        ...baseManifest().spec,
        steps: [{ id: 'install', type: 'script', script: 'scripts/fail.sh', on_fail: 'recover-install' }],
        recovery: [{ id: 'recover-install', steps: [{ id: 'recover', type: 'script', script: 'scripts/recover.sh' }] }],
      },
    });

    const result = await runSetupManifest({
      cwd: tmpDir,
      frameworkRoot: REPO_ROOT,
      platform: 'linux',
      paramValues: { INSTALL_DIR: tmpDir },
      skip: new Set(),
      yes: true,
    });

    expect(result.exitCode).toBe(7);
    expect(fs.readFileSync(recoveryMarker, 'utf8')).toBe('recovered');
  });
});

/**
 * `type: ask` headless behavior and the step preflight (#3062 review items
 * 10 and 13). Each manifest here declares no top-level `params`
 * requirement of its own, isolating these assertions from the
 * `INSTALL_DIR`-requires-a-param behavior exercised above.
 */
describe('setup manifest: ask steps and preflight ordering (#3062)', () => {
  let tmpDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-setup-manifest-ask-'));
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runManifest(spec: Record<string, unknown>, paramValues: Record<string, string> = {}) {
    writeManifest(tmpDir, {
      apiVersion: 'setup.aiwg.io/v1',
      kind: 'SetupManifest',
      metadata: { name: 'ask-step-sample', description: 'no os configuration required', install_type: 'developer' },
      spec: { platforms: [{ os: 'linux' }], ...spec },
    });
    return runSetupManifest({
      cwd: tmpDir, frameworkRoot: REPO_ROOT, platform: 'linux', paramValues, skip: new Set(), yes: true,
    });
  }

  it('an ask step with every declared param already supplied runs headless, logging which params answered it', async () => {
    const result = await runManifest({
      params: [{ name: 'DEPLOY_TARGET', type: 'string' }],
      steps: [{ id: 'confirm-target', type: 'ask', message: 'Which target?', params: ['DEPLOY_TARGET'] }],
    }, { DEPLOY_TARGET: 'staging' });

    expect(result.exitCode).toBe(0);
    expect(consoleLogSpy.mock.calls.flat().join(' ')).toContain('DEPLOY_TARGET');
    expect(mockAskString).not.toHaveBeenCalled();
  });

  it('an ask step with a missing declared param, without a terminal, refuses before the next step runs', async () => {
    mockIsInteractive.mockReturnValue(false);
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts', 'install.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    const result = await runManifest({
      params: [{ name: 'DEPLOY_TARGET', type: 'string' }],
      steps: [
        { id: 'install', type: 'script', script: 'scripts/install.sh' },
        { id: 'confirm-target', type: 'ask', message: 'Which target?', params: ['DEPLOY_TARGET'] },
      ],
    }, {});

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('DEPLOY_TARGET');
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).toContain('DEPLOY_TARGET');
    // Preflighted before any step runs — the earlier, unrelated script step
    // never executed either.
    expect(fs.existsSync(marker)).toBe(false);
  });

  // #3062 second review, finding 5b: a declared ask input missing AT a
  // terminal is prompted for, not refused.
  it.each([{}, { required: true }, { interactive_required: true }])('prompts at a terminal for missing ask inputs (%j) and passes answers to later steps', async required => {
    mockIsInteractive.mockReturnValue(true);
    promptAnswerQueue.push('staging');
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts', 'install.sh'), '#!/usr/bin/env sh\nprintf "$DEPLOY_TARGET" > ' + marker + '\n');
    const result = await runManifest({
      params: [{ name: 'DEPLOY_TARGET', type: 'string', ...required }],
      steps: [
        { id: 'confirm-target', type: 'ask', message: 'Which target?', params: ['DEPLOY_TARGET'] },
        { id: 'install', type: 'script', script: 'scripts/install.sh' },
      ],
    }, {});

    expect(result.exitCode).toBe(0);
    expect(mockAskString).toHaveBeenCalledTimes(1);
    // The interactively-captured answer is threaded into the later step's
    // env, same as a `--param`-supplied one would be.
    expect(fs.readFileSync(marker, 'utf8')).toBe('staging');
  });

  it('an ask step declaring no params at all is always refused — there is no interactive-capture mechanism for it, even at a terminal', async () => {
    for (const interactive of [false, true]) {
      mockIsInteractive.mockReturnValue(interactive);
      const result = await runManifest({
        steps: [{ id: 'confirm-target', type: 'ask', message: 'Which target?' }],
      }, {});

      expect(result.exitCode).not.toBe(0);
      expect(result.message).toContain("ask step 'confirm-target'");
      expect(result.message).toContain('declares no params');
      expect(mockAskString).not.toHaveBeenCalled();
    }
  });

  it('preflights an ask step nested inside a platform-route step before any step runs', async () => {
    mockIsInteractive.mockReturnValue(false);
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts', 'install.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    const result = await runManifest({
      params: [{ name: 'DEPLOY_TARGET', type: 'string' }],
      steps: [
        { id: 'install', type: 'script', script: 'scripts/install.sh' },
        {
          id: 'route',
          type: 'platform-route',
          routes: [{ platform: 'linux', steps: [{ id: 'confirm-target', type: 'ask', message: 'Which target?', params: ['DEPLOY_TARGET'] }] }],
        },
      ],
    }, {});

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('DEPLOY_TARGET');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a step marked interactive: true with no declared params is preflighted before an earlier normal step runs, without a terminal', async () => {
    mockIsInteractive.mockReturnValue(false);
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts', 'install.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    writeExecutable(path.join(tmpDir, 'scripts', 'ui.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    const result = await runManifest({
      steps: [
        { id: 'install', type: 'script', script: 'scripts/install.sh' },
        { id: 'open-ui', type: 'script', script: 'scripts/ui.sh', interactive: true },
      ],
    }, {});

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("step 'open-ui'");
    // Neither step ran — the first (harmless) step is never executed ahead
    // of the second step's refusal.
    expect(fs.existsSync(marker)).toBe(false);
  });

  // #3062 second review, finding 5b: an `interactive: true` step whose
  // declared params are ALL supplied runs headless instead of being
  // refused — the bug the review found ("still refuses supplied
  // interactive steps headlessly").
  it('a step marked interactive: true with every declared param supplied runs headless, without a terminal', async () => {
    mockIsInteractive.mockReturnValue(false);
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts', 'ui.sh'), '#!/usr/bin/env sh\nprintf "$DEPLOY_TARGET" > ' + marker + '\n');
    const result = await runManifest({
      params: [{ name: 'DEPLOY_TARGET', type: 'string' }],
      steps: [{ id: 'open-ui', type: 'script', script: 'scripts/ui.sh', interactive: true, params: ['DEPLOY_TARGET'] }],
    }, { DEPLOY_TARGET: 'staging' });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('staging');
  });

  it('a step marked interactive: true with a declared param still missing refuses, naming it, without a terminal', async () => {
    mockIsInteractive.mockReturnValue(false);
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts', 'ui.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    const result = await runManifest({
      params: [{ name: 'DEPLOY_TARGET', type: 'string' }],
      steps: [{ id: 'open-ui', type: 'script', script: 'scripts/ui.sh', interactive: true, params: ['DEPLOY_TARGET'] }],
    }, {});

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('DEPLOY_TARGET');
    expect(fs.existsSync(marker)).toBe(false);
  });

  // #3062 second review, finding 7: `agentic`/`chain` steps are refused
  // unconditionally by runStep(); the preflight must reject them up front
  // too, before any earlier step runs.
  it.each(['agentic', 'chain'] as const)('rejects a selected %s step up front, before an earlier normal step runs', async (type) => {
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts', 'install.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    // A `chain` step's referenced manifest must exist on disk to pass
    // schema validation before preflight is even reached; its content is
    // irrelevant since `chain` is always refused regardless.
    fs.mkdirSync(path.join(tmpDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'nested', 'setup.manifest.yaml'), 'placeholder: true\n');
    const extra = type === 'agentic' ? { instruction: 'do a thing' } : { manifest: './nested/setup.manifest.yaml' };
    const result = await runManifest({
      steps: [
        { id: 'install', type: 'script', script: 'scripts/install.sh' },
        { id: 'unsupported', type, ...extra },
      ],
    }, {});

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("'unsupported'");
    expect(fs.existsSync(marker)).toBe(false);
  });

  // Go/no-go review blocker 3: the previous preflight recursed into every
  // selected step's `on_fail` recovery up front, so a manifest whose main
  // sequence succeeds outright was refused solely because its *unused*
  // recovery contained something unsupported. The main sequence now runs
  // to completion regardless of what its unused recovery declares.
  it('runs the main sequence to completion with an unusable recovery defined that is never selected', async () => {
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts', 'install.sh'), '#!/usr/bin/env sh\nprintf ran > ' + marker + '\n');
    const result = await runManifest({
      params: [{ name: 'RECOVERY_TARGET', type: 'string' }],
      steps: [{ id: 'install', type: 'script', script: 'scripts/install.sh', on_fail: 'recover-install' }],
      recovery: [{
        // Would be refused if ever preflighted (no declared params at
        // all) — but `install` succeeds, so this is never selected.
        id: 'recover-install',
        steps: [{ id: 'confirm-recovery', type: 'ask', message: 'Recover how?' }],
      }],
    }, {});

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    expect(consoleErrorSpy.mock.calls.flat().join('\n')).not.toContain('confirm-recovery');
  });

  // Go/no-go review blocker 3 (was: "rejects an unresolved recovery
  // sequence up front, before the step it would recover ever runs" — the
  // *up front* part is exactly what blocker 3 removes). The main step now
  // runs (and fails) normally; only once that failure actually selects the
  // recovery is the recovery's own blocker found — and at that point
  // nothing in the recovery sequence has executed yet, verified by a
  // second marker the recovery's own first step would have written.
  it('a failure selecting a recovery with an unresolvable ask step refuses before any recovery step runs', async () => {
    const marker = path.join(tmpDir, 'marker');
    const recoveryMarker = path.join(tmpDir, 'recovery-marker');
    writeExecutable(path.join(tmpDir, 'scripts', 'fail.sh'), '#!/usr/bin/env sh\nprintf ran > ' + marker + '\nexit 7\n');
    writeExecutable(path.join(tmpDir, 'scripts', 'recovery-step.sh'), '#!/usr/bin/env sh\nprintf ran > ' + recoveryMarker + '\n');
    const result = await runManifest({
      params: [{ name: 'RECOVERY_TARGET', type: 'string' }],
      steps: [{ id: 'install', type: 'script', script: 'scripts/fail.sh', on_fail: 'recover-install' }],
      recovery: [{
        id: 'recover-install',
        steps: [
          { id: 'confirm-recovery', type: 'ask', message: 'Recover how?', params: ['RECOVERY_TARGET'] },
          { id: 'apply-recovery', type: 'script', script: 'scripts/recovery-step.sh' },
        ],
      }],
    }, {});

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('RECOVERY_TARGET');
    // The main step DID run — its own failure is what selected the
    // recovery in the first place.
    expect(fs.existsSync(marker)).toBe(true);
    // Zero recovery steps executed: not the blocked `ask` step, and not
    // the later script step that would have run after it.
    expect(fs.existsSync(recoveryMarker)).toBe(false);
  });
});
