import { mkdtempSync, mkdirSync, rmSync, writeFileSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScriptRunner, DefaultScriptRunner } from '../../../../src/cli/handlers/script-runner.js';

describe('DefaultScriptRunner', () => {
  let root: string;
  let runner: DefaultScriptRunner;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-script-runner-'));
    runner = new DefaultScriptRunner(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function script(source: string): string {
    writeFileSync(join(root, 'child.cjs'), source);
    return 'child.cjs';
  }

  // Pin the child to the same local Node version as the test process.
  function childEnv(): Record<string, string> {
    return { PATH: dirname(process.execPath) };
  }

  function deployer(source: string): string {
    mkdirSync(join(root, 'tools/agents'), { recursive: true });
    writeFileSync(join(root, 'tools/agents/deploy-agents.mjs'), source);
    return 'tools/agents/deploy-agents.mjs';
  }

  it.each([false, true])('surfaces Flue preservation warnings from captured successful deployment (subprocess=%s)', async subprocess => {
    const warning = 'Flue (experimental): keeping /project/src/db.ts (copy mode); remove this file manually.';
    const file = deployer(`
      export async function main() {
        console.warn(${JSON.stringify(warning)});
        console.error('unrelated diagnostic');
        return 0;
      }
      if (process.argv[1].endsWith('/deploy-agents.mjs')) await main();
    `);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runner.run(file, [], { capture: true, ...(subprocess ? { timeout: 10_000 } : {}) });
    expect(result.exitCode).toBe(0);
    expect(warn).toHaveBeenCalledExactlyOnceWith(warning);
  });

  it('reuses the deployment module, captures preview stdout and bounds stderr', async () => {
    const file = deployer(`
      let calls = 0;
      export async function main(args) {
        console.log('[dry-run] Would write /project/skill-' + (++calls) + '.md');
        if (args.length) { console.error('e'.repeat(2 * 1024 * 1024)); return 7; }
        return 0;
      }
    `);
    const fd = openSync(join(root, 'preview'), 'w');
    const before = globalThis.console;
    try {
      expect(await runner.run(file, [], { capture: true, stdoutFd: fd })).toEqual({ exitCode: 0 });
      expect(await runner.run(file, ['fail'], { capture: true, stdoutFd: fd }))
        .toEqual({ exitCode: 7, message: 'e'.repeat(1024 * 1024) });
      expect(globalThis.console).toBe(before);
      expect(readFileSync(join(root, 'preview'), 'utf8')).toBe(
        '[dry-run] Would write /project/skill-1.md\n[dry-run] Would write /project/skill-2.md\n',
      );
    } finally { closeSync(fd); }
  });

  it('serializes calls across runners and restores environment and console after a failure', async () => {
    const file = deployer(`
      let active = false;
      export async function main(args) {
        if (active) throw new Error('overlapping invocation');
        active = true;
        const root = process.env.AIWG_ROOT;
        try {
          await Promise.resolve();
          if (root !== process.env.AIWG_ROOT) throw new Error('environment leaked');
          if (args.length) throw new Error(root);
          console.error(root);
          return 3;
        } finally { active = false; }
      }
    `);
    const previousRoot = process.env.AIWG_ROOT;
    const before = globalThis.console;
    expect(await Promise.all([
      runner.run(file, ['fail'], { capture: true, env: { AIWG_ROOT: 'first' } }),
      new DefaultScriptRunner(root).run(file, [], { capture: true, env: { AIWG_ROOT: 'second' } }),
    ])).toEqual([{ exitCode: 1, message: 'first' }, { exitCode: 3, message: 'second' }]);
    expect(process.env.AIWG_ROOT).toBe(previousRoot);
    expect(globalThis.console).toBe(before);
  });

  it.each([
    { env: { AIWG_DEPLOY_SUBPROCESS: '1' } },
    { timeout: 10_000 },
    { cwd: tmpdir() },
    { env: { AIWG_TEST_ISOLATION: '1' } },
  ])('keeps subprocess isolation for %j', async options => {
    const file = deployer(`
      export async function main() { throw new Error('must run as a child'); }
      process.exitCode = 5;
    `);
    // #3648: every failure carries its message, so a silent child never
    // produces an empty ERROR line downstream.
    expect(await runner.run(file, [], { ...options, capture: true })).toEqual({
      exitCode: 5, message: 'Script exited with code 5: deploy-agents.mjs',
    });
  });

  it('reports a non-empty message for silent embedded deployment failures', async () => {
    const file = deployer(`
      export async function main() { return 3; }
    `);
    expect(await runner.run(file, [], { capture: true })).toEqual({
      exitCode: 3, message: 'Deployment script exited with code 3: deploy-agents.mjs',
    });
  });

  it('withholds selected resource variables from helpers, including embedded deployment, and restores the parent', async () => {
    const previous = process.env.AIWG_RESOURCE_TOKEN;
    process.env.AIWG_RESOURCE_TOKEN = 'synthetic-release-bearer';
    const omission = { capture: true, omitEnv: ['AIWG_RESOURCE_TOKEN', 'RELEASE_FIXTURE'] };
    try {
      const file = script(`
        if (process.env.AIWG_RESOURCE_TOKEN || process.env.RELEASE_FIXTURE) throw new Error('unexpected credential');
        if (process.argv.some(arg => arg.includes('synthetic-release-bearer'))) throw new Error('unexpected argv');
      `);
      expect(await runner.run(file, [], { ...omission, env: { ...childEnv(), RELEASE_FIXTURE: 'synthetic-release-bearer' } })).toEqual({ exitCode: 0 });
      const embedded = deployer(`
        export async function main() {
          if (process.env.AIWG_RESOURCE_TOKEN) throw new Error('unexpected credential');
          return 0;
        }
      `);
      expect(await runner.run(embedded, [], omission)).toEqual({ exitCode: 0 });
      expect(process.env.AIWG_RESOURCE_TOKEN).toBe('synthetic-release-bearer');
    } finally {
      if (previous === undefined) delete process.env.AIWG_RESOURCE_TOKEN;
      else process.env.AIWG_RESOURCE_TOKEN = previous;
    }
  });

  it('drains more than 1 MiB from both pipes and preserves the success contract', async () => {
    const file = script(`
      process.stdout.write('o'.repeat(2 * 1024 * 1024));
      process.stderr.write('e'.repeat(2 * 1024 * 1024));
    `);
    expect(await runner.run(file, [], { capture: true, timeout: 10_000, env: childEnv() }))
      .toEqual({ exitCode: 0 });
  });

  it('captures a preview to the caller-owned stdout file while retaining failure diagnostics', async () => {
    const output = join(root, 'preview.txt');
    const fd = openSync(output, 'w');
    try {
      const file = script("console.log('[dry-run] Would write /project/skill.md'); console.error('preview failed'); process.exitCode = 3;");
      const result = await runner.run(file, [], { capture: true, stdoutFd: fd, env: childEnv() });
      expect(result).toEqual({ exitCode: 3, message: 'preview failed' });
      expect(readFileSync(output, 'utf8')).toBe('[dry-run] Would write /project/skill.md\n');
    } finally { closeSync(fd); }
  });

  it('bounds failure diagnostics while continuing to drain both pipes', async () => {
    const file = script(`
      process.stdout.write('o'.repeat(2 * 1024 * 1024));
      process.stderr.write('e'.repeat(2 * 1024 * 1024) + 'discarded-tail');
      process.exitCode = 7;
    `);
    const result = await runner.run(file, [], { capture: true, timeout: 10_000, env: childEnv() });
    expect(result).toEqual({ exitCode: 7, message: 'e'.repeat(1024 * 1024) });
  });

  it('preserves ordinary stderr messages and exit codes', async () => {
    const file = script(String.raw`process.stderr.write('  failure: café  \n'); process.exitCode = 3;`);
    expect(await runner.run(file, [], { capture: true, env: childEnv() }))
      .toEqual({ exitCode: 3, message: 'failure: café' });
  });

  it('preserves the inherited-stdio return contract', async () => {
    expect(await createScriptRunner(root).run(script('process.exitCode = 5;'), [], { env: childEnv() }))
      .toEqual({ exitCode: 5 });
  });

  it('preserves timeout status and diagnostics', async () => {
    const file = script('setInterval(() => {}, 1000);');
    const result = await runner.run(file, [], { capture: true, timeout: 250, env: childEnv() });
    expect(result.exitCode).toBe(124);
    expect(result.message).toBe('Script timed out after 250ms');
    expect(result.error?.message).toMatch(/^Timeout after 250ms \(child sent SIGTERM, SIGKILL after \d+ms\)$/);
  });

  it('preserves spawn error status and diagnostics', async () => {
    const result = await runner.run(script(''), [], { capture: true, env: { PATH: root } });
    expect(result.exitCode).toBe(1);
    expect(result.message).toBe(`Script error: ${result.error?.message}`);
    expect(result.error).toMatchObject({ code: 'ENOENT' });
  });
});
