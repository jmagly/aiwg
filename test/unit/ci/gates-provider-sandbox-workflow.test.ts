import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from '../../helpers/temp-dir.js';

type Step = { name: string; if?: string; run?: string; 'continue-on-error'?: boolean };
const workflow = load(readFileSync('.gitea/workflows/ci.yml', 'utf8')) as {
  on: Record<string, unknown>; jobs: { test: { steps: Step[] } };
};
const steps = workflow.jobs.test.steps;
const gate = steps.find(step => step.name.includes('Require bundle provider sandbox suite'))!;

function runGate(bwrapExit?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'aiwg-provider-ci-'));
  if (bwrapExit !== undefined) {
    writeFileSync(join(dir, 'bwrap'), `#!/bin/sh\nexit ${bwrapExit}\n`, { mode: 0o755 });
  }
  // No real nested Vitest: observe its required-mode environment and propagate
  // a simulated suite failure through the actual workflow shell body.
  writeFileSync(join(dir, 'nice'), '#!/bin/sh\nprintf "%s\\n" "$AIWG_REQUIRE_PROVIDER_SANDBOX" "$@"\nexit 23\n', { mode: 0o755 });
  return spawnSync('/bin/sh', ['-eu', '-c', gate.run!], {
    env: { PATH: dir }, encoding: 'utf8', timeout: 10000,
  });
}

describe('bundle provider sandbox CI gate (#2846)', () => {
  it('runs after the build on pushes to main, without PR CI or failure suppression', () => {
    expect(workflow.on).not.toHaveProperty('pull_request');
    expect(gate.if).toBe("gitea.event_name == 'push' && gitea.ref == 'refs/heads/main'");
    expect(steps.indexOf(gate)).toBeGreaterThan(steps.findIndex(step => step.run === 'npm run build:cli'));
    expect(gate['continue-on-error']).not.toBe(true);
  });

  it('skips with a notice when bwrap is absent', () => {
    const result = runGate();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice::Skipping provider sandbox lane: bwrap is unavailable');
  });

  it('skips with a notice when user namespaces are unavailable', () => {
    const result = runGate(1);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice::Skipping provider sandbox lane: bwrap/user namespaces are unavailable');
  });

  it('requires the sandbox and propagates suite failures on capable runners', () => {
    const result = runGate(0);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(23);
    const args = result.stdout.trim().split('\n');
    expect(args.slice(0, 4)).toEqual(['1', '-n', '19', './node_modules/.bin/vitest']);
    expect(args).toContain('config/vitest.config.js');
    expect(args).toContain('--maxWorkers=4');
    for (const file of ['gates-provider-sandbox', 'gates-provider-isolation', 'gates-bundle-providers']) {
      expect(args).toContain(`test/conformance/gates-v1/${file}.test.ts`);
    }
  });

  it.each(['', '1'])('honours required sandbox mode %j when the capability test fails', async required => {
    vi.resetModules();
    const loader = await import('../../../src/gates/providers/loader.js');
    loader.configureIsolationSandboxForTests({ bwrapPath: '/nonexistent/aiwg-ci-bwrap' });
    vi.stubEnv('AIWG_REQUIRE_PROVIDER_SANDBOX', required);
    try {
      const helper = import('../../conformance/gates-v1/sandbox-helper.js');
      if (required === '1') await expect(helper).rejects.toThrow('Required provider sandbox failed:');
      else expect((await helper).SANDBOX_READY).toBe(false);
    } finally {
      loader.configureIsolationSandboxForTests(null);
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
