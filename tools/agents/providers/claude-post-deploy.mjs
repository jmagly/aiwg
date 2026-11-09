// Apply project settings and context after provider file deployment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importImpl } from '../../_resolve-impl.mjs';
import { initializeFrameworkWorkspace, ensureDir } from './base.mjs';
import { deployHookFile } from './claude.mjs';
import { deployConductorDataGuard } from './conductor-data-guard.mjs';

export async function postDeploy(targetDir, opts) {
  initializeFrameworkWorkspace(targetDir, opts.mode, opts.dryRun, opts.srcRoot);
  // Validate the data policy before publishing any settings; merge before its writes.
  await deployConductorDataGuard(targetDir, 'claude', { ...opts, dryRun: true });

  // Claude-specific post-deployment (settings.json, etc.)
  const claudeDir = path.join(targetDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // If settings.json doesn't exist, create a minimal one
  if (!fs.existsSync(settingsPath) && !opts.dryRun) {
    const { captureDeploymentOutputs, recordDeploymentOutputs } = await importImpl(import.meta.url, 'providers/deployment-ownership.mjs');
    const before = captureDeploymentOutputs([claudeDir]);
    ensureDir(claudeDir);
    const settings = {
      version: '1.0',
      created: new Date().toISOString(),
      aiwg: {
        enabled: true,
        mode: opts.mode || 'all'
      }
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    recordDeploymentOutputs(before, [claudeDir], { ...opts, writtenFiles: [settingsPath] });
    opts.writtenFiles?.push(settingsPath);
    console.log('Created .claude/settings.json');
  }

  const addonPass = /(?:agentic\/code|\.aiwg)\/(?:addons|extensions)\//.test((opts.logicalInputPath?.(opts.srcRoot) || opts.srcRoot)?.replaceAll('\\', '/') || '');

  // Full addon passes also refresh runtime scripts, using this package's source.
  const fullDeploy = !opts.commandsOnly && !opts.rulesOnly && (!opts.skillsOnly || opts.kernelOnly === true);
  const hooks = fullDeploy && opts.hooks === true && opts.scope !== 'user';
  if (opts.attribution !== false || hooks) {
    const { installAiwgHooks } = await importImpl(import.meta.url, 'extensions/claude-hooks-installer.js');
    const { deploymentOwner } = await importImpl(import.meta.url, 'providers/deployment-ownership.mjs');
    const result = await installAiwgHooks({ frameworkSlug: deploymentOwner(opts), claimUnchangedSettings: !addonPass, projectPath: targetDir, commandRoot: opts.logicalOutputPath?.(targetDir),
      frameworkRoot: fileURLToPath(new URL('../../../', import.meta.url)),
      attribution: opts.attribution !== false, hooks, dryRun: opts.dryRun });
    if (!opts.dryRun && result) opts.writtenFiles?.push(result.settingsPath, ...result.installedScripts);
    for (const warning of result?.warnings || []) console.warn(`Claude settings: ${warning}`);
  }
  await deployConductorDataGuard(targetDir, 'claude', opts);

  // Hook file architecture: write AIWG.md and wire @AIWG.md into CLAUDE.md
  if (opts.srcRoot && opts.contextFiles !== false) {
    deployHookFile(targetDir, opts);
  }
}
