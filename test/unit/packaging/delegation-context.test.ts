// Exercise the template from a staged lightweight CLI, where the full corpus is absent.
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { buildCliPackage } from '../../../tools/release/build-cli-package.mjs';

it('renders the delegation rubric from the lightweight CLI without installing a corpus', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-delegation-package-'));
  try {
    const stage = join(root, 'cli');
    await buildCliPackage({ outputDir: stage });
    await expect(access(join(stage, 'agentic/code/frameworks'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(stage, 'dist/src/models/models-v2.json'), 'utf8')).toBe(
      await readFile(resolve('agentic/code/frameworks/sdlc-complete/config/models-v2.json'), 'utf8'),
    );
    await symlink(resolve('node_modules'), join(stage, 'node_modules'), 'dir');
    const module = pathToFileURL(join(stage, 'dist/src/smiths/context-pipeline/delegation-rubric.js')).href;
    const { renderDelegationRubric, buildDelegationBridge } = await import(/* @vite-ignore */ module);
    const rubric = await renderDelegationRubric({ mode: 'default' });
    expect(rubric).toContain('Delegate by default');
    expect(rubric).toContain('cheapest capable worker');
    expect(rubric.split('\n').length).toBeLessThanOrEqual(15);
    vi.stubEnv('AIWG_HOME', stage);
    vi.stubEnv('AIWG_CONFIG', join(root, 'user'));
    const project = join(root, 'project');
    await mkdir(project);
    const loaderModule = pathToFileURL(join(stage, 'dist/src/models/config-loader.js')).href;
    const { ConfigLoader } = await import(/* @vite-ignore */ loaderModule);
    expect(new ConfigLoader(project).getLocations().aiwgDefault).toBe(join(stage, 'dist/src/models/models-v2.json'));
    expect((await new ConfigLoader(project).load()).defaults.provider).toBeTruthy();
    await writeFile(join(project, 'models.json'), '{"defaults":{"workerSelection":{"mode":"off"}}}');
    expect(await buildDelegationBridge(project)).toContain('Automatic delegation is off');
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
