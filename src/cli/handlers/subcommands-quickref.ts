// Focused subcommand handlers preserving the public facade.
import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";
/** Generate or deploy the canonical project quickref. */
export const quickrefHandler: CommandHandler = {
  id: 'quickref',
  name: 'Project Quickref',
  description: 'Generate and deploy an always-visible project quickref',
  category: 'project',
  aliases: [],

  async help(): Promise<HandlerResult> {
    return { exitCode: 0, message: 'Usage: aiwg quickref generate|deploy --project [--provider <id>] [--dry-run]', rawOutput: true };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const action = ctx.args.find(arg => !arg.startsWith('-')) ?? 'generate';
    if (!ctx.args.includes('--project')) {
      return { exitCode: 1, message: 'Error: project quickrefs require --project\n\nUsage: aiwg quickref generate|deploy --project [--provider <id>] [--dry-run]' };
    }
    if (!['generate', 'deploy'].includes(action)) {
      return { exitCode: 1, message: `Error: unknown quickref action '${action}' (expected generate or deploy)` };
    }

    const {
      generateProjectQuickref,
      deployProjectQuickref,
    } = await import('../../extensions/project-quickref.js');
    try {
      if (action === 'generate') {
        const result = await generateProjectQuickref(ctx.cwd, { dryRun: ctx.dryRun });
        const verb = ctx.dryRun ? 'Would generate' : result.changed ? 'Generated' : 'Unchanged';
        console.log(`${verb} ${result.skillName}`);
        console.log(`  Source: ${result.sourcePath}`);
        console.log(`  Output: ${result.outputPath}`);
        for (const warning of result.warnings) console.log(`  Warning: ${warning}`);
        if (ctx.dryRun) {
          console.log('\n--- preview ---\n');
          console.log(result.content);
        }
        return { exitCode: 0 };
      }

      const providerIndex = ctx.args.indexOf('--provider');
      const explicitProvider = providerIndex >= 0 ? ctx.args[providerIndex + 1] : undefined;
      const { readAiwgConfig } = await import('../../config/aiwg-config.js');
      const config = await readAiwgConfig(ctx.cwd);
      const providers = explicitProvider ? [explicitProvider] : (config?.providers ?? []);
      if (providers.length === 0) {
        return { exitCode: 1, message: 'No providers configured. Pass --provider <id> or add providers to .aiwg/aiwg.config.' };
      }
      for (const provider of providers) {
        const result = await deployProjectQuickref(ctx.cwd, provider, { dryRun: ctx.dryRun });
        const verb = ctx.dryRun ? 'Would deploy' : result.changed ? 'Deployed' : 'Unchanged';
        console.log(`${verb} ${result.skillName} -> ${result.provider}: ${result.targetPath}${result.emulated ? ' (emulated skill surface)' : ''}`);
        for (const stale of result.pruned) {
          console.log(`  ${ctx.dryRun ? 'Would prune' : 'Pruned'} stale managed quickref: ${stale}`);
        }
      }
      return { exitCode: 0 };
    } catch (error) {
      return { exitCode: 1, message: `Project quickref failed: ${(error as Error).message}` };
    }
  },
};

