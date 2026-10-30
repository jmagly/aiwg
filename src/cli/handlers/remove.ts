// Focused subcommand handlers preserving the public facade.
import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";
import { createScriptRunner } from "./script-runner.js";
import { getFrameworkRoot } from "../../channel/manager.mjs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getProjectDir } from "../../config/aiwg-config.js";
import { removeClaudeAttribution } from "../../extensions/claude-hooks-installer.js";
import { isScopeUser } from "./subcommands-list-format.js";
import { firstRemovePositional, parseRemoveProvider } from "./remove-options.js";
import { removeUserScopeDeploy } from "./remove-user.js";

/**
 * Remove framework handler
 *
 * Delegates to tools/plugin/plugin-uninstaller-cli.mjs
 */
export const removeHandler: CommandHandler = {
  id: "remove",
  name: "Remove Framework",
  description: "Remove installed framework, plugin, or project-local bundle",
  category: "framework",
  aliases: [],

  async help(): Promise<HandlerResult> {
    return { exitCode: 0, rawOutput: true, message: [
      'Usage: aiwg remove <id> [options]',
      '',
      'Remove an installed framework, plugin, or project-local bundle by id (for example all or sdlc).',
      'Project scope is the default; without --provider, process all recorded provider deployments.',
      '"all" is an installed bundle id, not a wildcard for every installed entry.',
      'Bundled deployments use ownership receipts to remove unchanged agents, commands, rules and skills.',
      'Project-local removal reverts deployed artifacts using recorded hashes; bundle source is preserved.',
      '',
      'Options:',
      '  --dry-run          List planned removals and preserved paths with reasons; write nothing.',
      '  --provider <p>     Select one recorded provider deployment.',
      '  --keep-registry    Keep project installed/deployedTo records after removal. By default,',
      '                     remove selected deployment records and drop the id when none remain.',
      '                     Project-local partial reverts retain their registry records.',
      '  --force            Override project-local mutation refusal or legacy plugin dependency checks;',
      '                     does not override bundled file hash/ownership preservation.',
      '  --scope user       Remove the user-scope mirror using ~/.aiwg/installed.json instead.',
      '  --user             Alias for --scope user; user mirror removal updates its own registry.',
      '  --target <d>       Target a project directory (alias: --prefix; default: cwd).',
      '  --help, -h         Show this help.',
      '',
      'Bundled file removal preserves modified files, unrecorded operator files, foreign skills,',
      'and symlinks inside skill directories. Project-local bundle source is never deleted.',
      'Legacy outputs without receipts are unverifiable and preserved.',
      'Settings and hooks with contribution receipts are preserved for separate recovery.',
      'User-scope legacy records without artifact manifests require manual file cleanup.',
      'Unregistered ids fall back to the legacy plugin uninstaller (also supports --keep-data).',
      '',
      'Examples:',
      '  aiwg remove all --dry-run',
      '  aiwg remove sdlc --provider claude --dry-run',
      '  aiwg remove my-bundle --keep-registry',
      '  aiwg remove sdlc --scope user --provider codex --dry-run',
    ].join('\n') };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    // Explicit provider removal is separate from framework removal. The native
    // adapter validates receipt hashes and preserves operator modifications.
    const nativeRemovalProvider = parseRemoveProvider(ctx.args);
    if (firstRemovePositional(ctx.args) === 'omp' && nativeRemovalProvider.provider === 'omp') {
      // Loaded from the package root, not by a path relative to this file: the
      // compiled handler sits one directory deeper than its source.
      const { uninstall } = (await import(pathToFileURL(path.join(await getFrameworkRoot(), 'tools/agents/providers/omp.mjs')).href)) as typeof import('../../../tools/agents/providers/omp.mjs');
      const { getProjectDir } = await import('../../config/aiwg-config.js');
      const dryRun = ctx.args.includes('--dry-run');
      const scope = ctx.args.includes('--user') || isScopeUser(ctx.args) ? 'user' : 'project';
      const count = uninstall(getProjectDir({ cwd: ctx.cwd }, ctx.args), { dryRun, scope });
      return { exitCode: 0, message: `${dryRun ? 'Would remove' : 'Removed'} ${count} unchanged OMP-owned files; operator files preserved.` };
    }

    // #1156 Phase 1 — `--scope user` / `--user`: revert the user-scope mirror
    // for the given framework. Independent of any project; reads the per-user
    // registry at ~/.aiwg/installed.json to find what was deployed, deletes
    // the mirrored artifacts under the provider's USER_SCOPE_PATHS, and
    // updates the registry.
    if (ctx.args.includes('--user') || isScopeUser(ctx.args)) {
      return await removeUserScopeDeploy(ctx.args);
    }

    if (firstRemovePositional(ctx.args) === 'grok-build') {
      const providerParse = parseRemoveProvider(ctx.args);
      if (providerParse.provider !== 'grok-build' || providerParse.error) {
        return { exitCode: 1, message: 'Use aiwg remove grok-build --provider grok-build [--dry-run] for reviewed project-scope removal.' };
      }
      const frameworkRoot = await getFrameworkRoot();
      const { uninstall } = (await import(pathToFileURL(path.join(frameworkRoot, 'tools/agents/providers/grok-build.mjs')).href)) as typeof import('../../../tools/agents/providers/grok-build.mjs');
      const { readAiwgConfig, writeAiwgConfig } = await import('../../config/aiwg-config.js');
      const target = getProjectDir({ cwd: ctx.cwd }, ctx.args);
      const dryRun = ctx.args.includes('--dry-run');
      const report = uninstall(target, { dryRun, srcRoot: frameworkRoot });
      if (!dryRun && report.skipped.length === 0) {
        const config = await readAiwgConfig(target);
        if (config) {
          for (const [name, entry] of Object.entries(config.installed ?? {})) {
            delete entry.deployedTo?.['grok-build'];
            if (Object.keys(entry.deployedTo ?? {}).length === 0) delete config.installed[name];
          }
          await writeAiwgConfig(target, config);
        }
      }
      const lines = [
        `${dryRun ? 'Would remove' : 'Removed'} ${dryRun ? report.planned.length : report.removed.length} unchanged AIWG-owned Grok Build artifact(s).`,
        ...report.planned.map(relative => `  ${relative}`),
        ...report.skipped.map(relative => `  Preserved modified or unverifiable: ${relative}`),
        'Operator-owned Grok content and shared context files are preserved.',
      ];
      return { exitCode: report.skipped.length ? 1 : 0, message: lines.join('\n') };
    }

    // #1037 — Project-local-aware remove. If the first positional arg matches
    // a project-local entry in `installed`, route to the new handler.
    // Otherwise fall through to the existing plugin-uninstaller flow.
    const positionalArg = firstRemovePositional(ctx.args);
    const providerParse = parseRemoveProvider(ctx.args);
    if (providerParse.error) {
      return {
        exitCode: 1,
        message: `${providerParse.error}\n\nUsage: aiwg remove <id> [--force] [--dry-run] [--provider <p>] [--keep-registry]`,
      };
    }
    if (!positionalArg) {
      return {
        exitCode: 1,
        message: 'Error: framework or bundle id required\n\nUsage: aiwg remove <id> [--force] [--dry-run] [--provider <p>] [--keep-registry]',
      };
    }
    if (positionalArg) {
      try {
        const { readAiwgConfig, writeAiwgConfig, getProjectDir } = await import(
          '../../config/aiwg-config.js'
        );
        const { removeProjectLocalBundle } = await import(
          '../../extensions/project-local-remove.js'
        );
        const projectDir = getProjectDir({ cwd: ctx.cwd }, ctx.args);
        const config = await readAiwgConfig(projectDir);
        const entry = config?.installed?.[positionalArg];
        if (config && entry && entry.source !== 'project-local') {
          const { resolveFrameworkDir } = await import('./use.js');
          const { removeBundledDeployment } = await import('./remove-bundled.js');
          const providers = Object.keys(entry.deployedTo).filter(p => !providerParse.provider || p === providerParse.provider);
          if (providerParse.provider && providers.length === 0) {
            return { exitCode: 1, message: `Error: '${positionalArg}' is not deployed for provider '${providerParse.provider}'.` };
          }
          return removeBundledDeployment(projectDir, positionalArg, resolveFrameworkDir(positionalArg) ?? positionalArg, config, providers, {
            dryRun: ctx.args.includes('--dry-run'), keepRegistry: ctx.args.includes('--keep-registry'),
          });
        }
        if (config && entry?.source === 'project-local') {
          const force = ctx.args.includes('--force');
          const dryRun = ctx.args.includes('--dry-run');
          const keepRegistry = ctx.args.includes('--keep-registry');
          const provider = providerParse.provider;

          const result = await removeProjectLocalBundle(
            config, projectDir, positionalArg, { force, dryRun, keepRegistry, provider },
          );

          // Print outcome summary
          const lines: string[] = [];
          if (dryRun) lines.push(`[dry-run] Plan for project-local '${positionalArg}':`);
          for (const o of result.outcomes) {
            const marker = o.reverted ? '✓' : '⚠';
            lines.push(`  ${marker} ${o.provider} :: ${o.artifactPath}  [${o.case}] ${o.message}`);
          }
          if (result.revertedProviders.length > 0) {
            lines.push(`Fully reverted: ${result.revertedProviders.join(', ')}`);
          }
          if (result.partialProviders.length > 0) {
            lines.push(`Partial (registry preserved): ${result.partialProviders.join(', ')}`);
          }
          if (lines.length > 0) console.log(lines.join('\n'));

          if (!dryRun) {
            await writeAiwgConfig(projectDir, config);
            if (result.revertedProviders.includes('claude') && !Object.values(config.installed).some(item => item.deployedTo.claude)) await removeClaudeAttribution(projectDir);
          }

          // Note: source under .aiwg/<type>/<name>/ is intentionally NOT
          // deleted (load-bearing invariant from #1048 design).
          return {
            exitCode: result.partialProviders.length > 0 ? 1 : 0,
            message: result.partialProviders.length > 0
              ? `Some artifacts skipped (see above). Use --force to override mutation refusal.`
              : '',
          };
        }
      } catch (err) {
        // A failed receipt/config read must never trigger a second, legacy deletion path.
        const msg = err instanceof Error ? err.message : String(err);
        return { exitCode: 1, message: `Framework removal pre-check failed: ${msg}` };
      }
    }

    if (providerParse.provider) {
      return {
        exitCode: 1,
        message: `Error: --provider is only supported for project-local or user-scope remove. '${positionalArg}' is not a project-local bundle.\n\nUse 'aiwg remove ${positionalArg}' without --provider, or 'aiwg remove ${positionalArg} --scope user --provider ${providerParse.provider}' for a user-scope mirror. Refs #1610.`,
      };
    }

    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run("tools/plugin/plugin-uninstaller-cli.mjs", ctx.args, {
      cwd: ctx.cwd,
    });
  },
};
