// Apply project settings and context after provider file deployment.
import { importImpl } from '../../_resolve-impl.mjs';
import { fileURLToPath } from 'node:url';
import { initializeFrameworkWorkspace, resolveAiwgRoot } from './base.mjs';
import { createAgentsMd } from './codex.mjs';
import { deployConductorDataGuard } from './conductor-data-guard.mjs';

export async function postDeploy(targetDir, opts) {
  initializeFrameworkWorkspace(targetDir, opts.mode, opts.dryRun, opts.srcRoot);
  await deployConductorDataGuard(targetDir, 'codex', opts);

  const fullDeploy = !opts.commandsOnly && !opts.rulesOnly && (!opts.skillsOnly || opts.kernelOnly === true);
  if (fullDeploy && opts.hooks !== false && opts.scope !== 'user') {
    const { installCodexPromptDiscovery } = await importImpl(import.meta.url, 'smiths/hook-bridge/codex-translator.js');
    const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const frameworkRoot = resolveAiwgRoot(opts.srcRoot || packageRoot) || packageRoot;
    await installCodexPromptDiscovery({ projectPath: targetDir, frameworkRoot, dryRun: opts.dryRun });
  }

  if (opts.createAgentsMd) {
    if (opts.contextFiles !== false) createAgentsMd(targetDir, opts.srcRoot, opts.dryRun);
  }
}
