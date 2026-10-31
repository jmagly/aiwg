// Redeploy each selected bundle only to its declared providers.
import { bundleCopyArgs } from './bundle-deployment-mode.js';
import type { AiwgConfig } from '../../config/aiwg-config.js';
import { withInstalledSelection } from '../../config/installed-selection.js';
import { bundleProviders, bundleUseName, pruneUndeclaredBundles, pruneAfterScopedDeployments } from './bundle-reconciliation.js';
import type { CommandHandler, HandlerContext } from './types.js';
export async function refreshDeclaredBundles(ctx: HandlerContext, config: AiwgConfig | null, frameworks: string[], requested: string | undefined,
  opts: { handler: CommandHandler; frameworkRoot: string; dryRun: boolean; quiet: boolean; forceDeploy: boolean; modelDeployArgs: string[] }): Promise<string[]> {
  const failed: string[] = [];
  if (await pruneUndeclaredBundles(ctx.cwd, config, requested, opts.dryRun, opts.frameworkRoot)) failed.push('prune');
  if (!frameworks.length && !opts.quiet) console.log('  No installed frameworks or addons to re-deploy');
  for (const fw of frameworks) for (const provider of bundleProviders(config?.installed ?? {}, fw, requested)) {
    const copyArgs = bundleCopyArgs(config?.installed ?? {}, fw, provider);
    if (opts.dryRun) { console.log(`    Would re-deploy: ${fw} for ${provider} — aiwg use ${bundleUseName(fw)} --provider ${provider}${copyArgs.length ? ` ${copyArgs.join(' ')}` : ''}`); continue; }
    const result = await withInstalledSelection(ctx.cwd, config?.installed, () => opts.handler.execute({ ...ctx, frameworkRoot: opts.frameworkRoot,
      args: [bundleUseName(fw), '--provider', provider, '--target', ctx.cwd, '--yes', '--json', ...copyArgs,
        ...(opts.forceDeploy ? ['--force'] : []), ...(ctx.args.includes('--allow-over-budget') ? ['--allow-over-budget'] : []), ...opts.modelDeployArgs],
      rawArgs: ['use', fw],
    }));
    if (result.exitCode) { failed.push(fw); if (!opts.quiet) console.warn(`Deploy issue: ${fw} for ${provider} (exit ${result.exitCode}): ${result.message || ''}`); }
    else if (!opts.quiet) console.log(`Deployed: ${fw} for ${provider}`);
  }
  if (!opts.dryRun && await pruneAfterScopedDeployments(ctx.cwd, config, requested, opts.frameworkRoot)) failed.push('prune');
  return failed;
}
