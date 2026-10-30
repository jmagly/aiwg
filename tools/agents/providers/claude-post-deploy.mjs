// Apply project settings and context after provider file deployment.
import fs from 'node:fs';
import path from 'node:path';
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

  // Reuse the settings owner's backup/atomic merge, independently of hooks.
  if (opts.attribution !== false) {
    const { installAiwgHooks } = await importImpl(import.meta.url, 'extensions/claude-hooks-installer.js');
    const { deploymentOwner } = await importImpl(import.meta.url, 'providers/deployment-ownership.mjs');
    const result = await installAiwgHooks({ frameworkSlug: deploymentOwner(opts), claimUnchangedSettings: !addonPass, projectPath: targetDir, frameworkRoot: opts.srcRoot || targetDir,
      attribution: opts.attribution !== false, hooks: false, dryRun: opts.dryRun });
    if (!opts.dryRun && result) opts.writtenFiles?.push(result.settingsPath);
    for (const warning of result?.warnings || []) console.warn(`Claude settings: ${warning}`);
  }
  await deployConductorDataGuard(targetDir, 'claude', opts);

  // Hook file architecture: write AIWG.md and wire @AIWG.md into CLAUDE.md
  if (opts.srcRoot && opts.contextFiles !== false) {
    deployHookFile(targetDir, opts);
  }
}
