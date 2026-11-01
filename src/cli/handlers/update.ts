// Update planning and redeployment of the existing project selection.
import fs from 'fs';
import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { updateInstallation } from '../../update/service.mjs';
import { useHandler as useFrameworkHandler } from './use.js';
import { projectAiwgPath } from '../../config/project-artifacts.js';
import type { AiwgConfig } from '../../config/aiwg-config.js';
import { getConfigPath } from '../../config/aiwg-config.js';
import { bundleCopyArgs } from './bundle-deployment-mode.js';
import { bundleProviders, pruneUndeclaredBundles, pruneAfterScopedDeployments } from './bundle-reconciliation.js';
import { readAiwgConfig } from '../../config/aiwg-config.js';
import { withInstalledSelection } from '../../config/installed-selection.js';

import { REGISTRY_ID_TO_USE_NAME } from '../../config/framework-aliases.js';

interface FrameworkRegistry {
  version: string;
  created: string;
  frameworks: Array<{
    id: string;
    installed: string;
    version: string;
  }>;
}

/**
 * Read the installed frameworks from the on-disk registry.
 */
function readFrameworkRegistry(cwd: string): FrameworkRegistry | null {
  const registryPath = projectAiwgPath(cwd, 'frameworks', 'registry.json');
  if (!fs.existsSync(registryPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Handler for update command
 *
 * Updates AIWG and re-deploys installed frameworks/addons.
 * - Checks for npm/git updates first
 * - Uses aiwg.config installed; reports legacy fallback for old projects
 * - Re-deploys only those (preserving the user's current selection)
 * - Use --all to deploy and record everything (equivalent to `aiwg use all`)
 *
 * Usage:
 *   aiwg update                        # Update + re-deploy installed frameworks
 *   aiwg update --all                  # Update + deploy everything
 *   aiwg update --dry-run              # Show what would be updated
 *   aiwg update --provider <name>      # Pass through provider to deployment
 *   aiwg update --skip-check           # Skip npm/git update check, only re-deploy
 *
 * @issue #342
 */
export const updateHandler: CommandHandler = {
  id: 'update',
  name: 'Update',
  description: 'Update AIWG and re-deploy installed frameworks',
  category: 'maintenance',
  aliases: ['-update', '--update', 'upgrade'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const args = ctx.args;
    const deployAll = args.includes('--all');
    const dryRun = args.includes('--dry-run');
    const skipCheck = args.includes('--skip-check');

    // Extract --provider value if present
    const providerIdx = args.findIndex(a => a === '--provider' || a === '--platform');
    const providerArgs = providerIdx >= 0 && args[providerIdx + 1]
      ? ['--provider', args[providerIdx + 1]]
      : [];

    // Step 1: Check for package updates (unless --skip-check)
    if (!skipCheck) {
      try {
        console.log('Updating AIWG installation...\n');
        const update = await updateInstallation({
          dryRun,
          offline: args.includes('--offline'),
        });
        console.log(`${update.message}\n`);
      } catch (error) {
        if ((error as { code?: string }).code === 'AIWG_INSTALLATION_DRIFT'
          || (error as { code?: string }).code === 'AIWG_INSTALLATION_INVALID') {
          return { exitCode: 78, message: error instanceof Error ? error.message : String(error) };
        }
        console.error(`Warning: Update check failed: ${error instanceof Error ? error.message : String(error)}`);
        console.log('Continuing with re-deployment...\n');
      }
    }

    // Read the control-plane file before normalization: the loader defaults an
    // absent installed block to {}, which would hide the legacy fallback gate.
    let installed: AiwgConfig['installed'] | undefined;
    try {
      const configPath = getConfigPath(ctx.cwd);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (Object.hasOwn(config, 'installed')) {
          if (!config.installed || typeof config.installed !== 'object' || Array.isArray(config.installed)) {
            throw new Error('installed must be an object');
          }
          installed = config.installed;
        }
      }
    } catch (error) {
      return { exitCode: 1, message: `Cannot plan update from aiwg.config: ${error instanceof Error ? error.message : String(error)}` };
    }

    const useName = (id: string) => REGISTRY_ID_TO_USE_NAME[id] ?? id;
    // With config authority the registry is diagnostic only; it never supplies
    // deployment candidates. Only an absent installed block enables fallback.
    const registry = readFrameworkRegistry(ctx.cwd);
    const configured = installed === undefined ? undefined : Object.keys(installed);
    if (configured === undefined) {
      console.log('Legacy fallback: aiwg.config has no installed block; using .aiwg/frameworks/registry.json');
    } else if (!deployAll) {
      const selected = new Set(configured.map(useName));
      const skipped = (registry?.frameworks ?? []).filter(item => !selected.has(useName(item.id)));
      if (skipped.length) console.log(`Skipped legacy registry frameworks: ${skipped.map(item => item.id).join(', ')}`);
    }
    const installedFrameworks = deployAll ? ['all'] : [...new Set(
      (configured ?? registry?.frameworks.map(item => item.id) ?? []).map(useName)
    )];
    let pruneFailures = !deployAll && installed !== undefined
      ? await pruneUndeclaredBundles(ctx.cwd, await readAiwgConfig(ctx.cwd), providerArgs[1], dryRun, ctx.frameworkRoot) : 0;
    const deployments = installedFrameworks.flatMap(fw => installed === undefined || deployAll
      ? [{ fw, args: providerArgs }]
      : bundleProviders(installed, fw, providerArgs[1]).map(provider => ({ fw, args: ['--provider', provider, ...bundleCopyArgs(installed, fw, provider)] })));
    if (installedFrameworks.length === 0) {
      console.log('No installed frameworks to re-deploy. Use aiwg use <framework> to install one.');
      return { exitCode: pruneFailures ? 1 : 0 };
    }

    // Report what will be updated
    console.log(`Installed frameworks: ${installedFrameworks.join(', ')}`);
    console.log('');

    if (dryRun) {
      console.log('Dry run: Would re-deploy the following frameworks:');
      for (const { fw, args } of deployments) {
        console.log(`  - aiwg use ${[fw, ...args].join(' ')}`);
      }
      return { exitCode: pruneFailures ? 1 : 0 };
    }

    // Step 3: Re-deploy each installed framework
    const results: Array<{ framework: string; exitCode: number }> = [];

    for (const { fw, args } of deployments) {
      console.log(`Re-deploying ${fw}...`);
      const deploy = () => useFrameworkHandler.execute({
        ...ctx,
        args: [fw, ...args],
      });
      const result = await (deployAll ? deploy() : withInstalledSelection(ctx.cwd, installed, deploy));
      results.push({ framework: fw, exitCode: result.exitCode });

      if (result.exitCode !== 0) {
        console.error(`Warning: Failed to re-deploy ${fw}: ${result.message || `exit ${result.exitCode}`}`);
      }
    }

    if (!deployAll) pruneFailures += await pruneAfterScopedDeployments(ctx.cwd, await readAiwgConfig(ctx.cwd), providerArgs[1], ctx.frameworkRoot);

    // Step 4: Report summary
    console.log('');
    console.log('Update Summary:');
    const succeeded = results.filter(r => r.exitCode === 0);
    const failed = results.filter(r => r.exitCode !== 0);

    for (const r of results) {
      const status = r.exitCode === 0 ? 'updated' : 'FAILED';
      console.log(`  ${r.framework}: ${status}`);
    }

    console.log('');
    console.log(`Updated: ${succeeded.length}/${results.length}`);

    return {
      exitCode: failed.length > 0 || pruneFailures ? 1 : 0,
      message: failed.length > 0
        ? `Some frameworks failed to update: ${failed.map(f => f.framework).join(', ')}`
        : `Successfully updated ${succeeded.length} framework(s)`,
    };
  },
};
