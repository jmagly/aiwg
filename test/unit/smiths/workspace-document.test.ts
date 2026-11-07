// Keep generated artifact routing consistent with the CLI's write-readiness contract.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactsHandler } from '../../../src/cli/handlers/artifacts.js';
import { ensureWorkspaceContext } from '../../../src/smiths/context-pipeline/workspace-document.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-workspace-routing-'));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) {
    vi.stubEnv(key, '');
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function artifactPath(checkWrite = true) {
  const args = ['path', '--json', ...(checkWrite ? ['--check-write'] : [])];
  return artifactsHandler.execute({ args, rawArgs: ['artifacts', ...args], cwd: root,
    frameworkRoot: root, dryRun: false });
}

async function routing() {
  await ensureWorkspaceContext(root);
  const document = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
  return document.split('### Artifact Routing\n\n')[1].split('\n\n### Linked Context')[0];
}

describe('WORKSPACE.md artifact routing (#3870)', () => {
  it('allows local payload when the CLI returns the default local root as write-ready', async () => {
    const checked = await artifactPath();
    expect(checked.exitCode).toBe(0);
    expect(JSON.parse(checked.message!)).toMatchObject({ artifact_root: join(root, '.aiwg'),
      external: false, write_ready: true, write_error: null });

    const guidance = await routing();
    expect(guidance).toContain('repository-local `.aiwg` stores AIWG payload');
    expect(guidance).not.toContain('- Only `aiwg.config`');
    expect(guidance).toMatchSnapshot();
  });

  it.each(['pointer', 'environment'])('rejects an unavailable external root configured through %s', async (source) => {
    const corpus = join(root, 'offline-corpus');
    if (source === 'pointer') await writeFile(join(root, '.aiwg-location'), 'offline-corpus\n');
    else vi.stubEnv('AIWG_ARTIFACTS_PATH', corpus);

    const checked = await artifactPath();
    expect(checked.exitCode).toBe(1);
    expect(checked.message).toContain(`Configured external AIWG artifact root is unavailable: ${corpus}`);
    expect(checked.message).toContain('Reconnect or attach the external corpus');
    expect(checked.message).toContain('will not fall back to repository-local .aiwg payload');
    const inspected = await artifactPath(false);
    expect(JSON.parse(inspected.message!)).toMatchObject({ artifact_root: corpus,
      external: true, write_ready: false, write_error: checked.message });

    const guidance = await routing();
    expect(guidance).toContain('- Only `aiwg.config`');
    expect(guidance).toContain('If the configured external artifact root is unavailable');
    expect(guidance).toContain('never fall back to repository-local payload');
    expect(guidance).toContain('`AIWG_ARTIFACTS_PATH`');
    expect(guidance).toContain('`.aiwg-location`');
    expect(guidance).toMatchSnapshot();
    expect(existsSync(corpus)).toBe(false);
    expect(existsSync(join(root, '.aiwg'))).toBe(false);
  });

  it('refreshes the routing guidance when an external pointer is added or removed', async () => {
    const local = await routing();
    await writeFile(join(root, '.aiwg-location'), 'offline-corpus\n');
    const external = await routing();
    expect(external).not.toBe(local);
    await rm(join(root, '.aiwg-location'));
    expect(await routing()).toBe(local);
  });
});
