// Focused subcommand handlers preserving the public facade.
import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";
import { getFrameworkRoot } from "../../channel/manager.mjs";
/**
 * Promote handler — graduate a project-local bundle to upstream or to a
 * private corpus path. Implements the design at
 * @.aiwg/architecture/design-doctor-log-promote.md (#1049).
 *
 * Usage:
 *   aiwg promote <name>                          # default: --to upstream
 *   aiwg promote <name> --to upstream
 *   aiwg promote <name> --to corpus <path>
 *   aiwg promote <name> --dry-run
 *   aiwg promote <name> --cleanup
 *   aiwg promote <name> --force
 *
 * @implements #1037
 */
export const promoteHandler: CommandHandler = {
  id: 'promote',
  name: 'Promote',
  description: 'Graduate a project-local bundle to upstream or a corpus path',
  category: 'framework',
  aliases: ['-promote', '--promote', 'graduate'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const args = ctx.args;
    const positional = args.find(a => !a.startsWith('-'));
    if (!positional) {
      return { exitCode: 1, message: 'Error: bundle name required\n\nUsage: aiwg promote <name> [--to upstream|corpus <path>] [--dry-run] [--cleanup] [--force]' };
    }

    const toIdx = args.findIndex(a => a === '--to');
    const toValue = toIdx >= 0 ? args[toIdx + 1] : 'upstream';
    let corpusPath: string | undefined;
    if (toValue === 'corpus') {
      // The argument *after* "corpus" is the path
      corpusPath = args[toIdx + 2];
      if (!corpusPath || corpusPath.startsWith('-')) {
        return { exitCode: 1, message: 'Error: --to corpus requires a path argument' };
      }
    } else if (toValue !== 'upstream') {
      return { exitCode: 1, message: `Error: --to must be 'upstream' or 'corpus' (got '${toValue}')` };
    }

    const dryRun = args.includes('--dry-run');
    const cleanup = args.includes('--cleanup');
    const force = args.includes('--force');

    try {
      const { readAiwgConfig, writeAiwgConfig, getProjectDir } = await import('../../config/aiwg-config.js');
      const { promoteProjectLocalBundle } = await import('../../extensions/project-local-promote.js');

      const projectDir = getProjectDir({ cwd: ctx.cwd }, args);
      const config = await readAiwgConfig(projectDir);
      if (!config) {
        return { exitCode: 1, message: 'Error: no .aiwg/aiwg.config found — run `aiwg init` first' };
      }

      const fr = await getFrameworkRoot();
      const result = await promoteProjectLocalBundle(config, projectDir, positional, {
        to: toValue as 'upstream' | 'corpus',
        corpusPath,
        dryRun,
        cleanup,
        force,
        frameworkRoot: fr,
      });

      if (!result.ok) {
        return { exitCode: 1, message: `Error: ${result.message ?? result.failureReason}` };
      }

      if (dryRun && result.plan) {
        console.log('[dry-run] Would copy:');
        console.log(`  ${result.plan.source} → ${result.plan.destination}`);
        console.log(`  Files: ${result.plan.files.length}, ${result.plan.totalBytes} bytes`);
        console.log('  Pre-flight: ✓ manifest valid  ✓ destination clean');
        console.log('  Hash verification: skipped (dry-run)');
        console.log(`  Registry update: source: project-local → ${toValue === 'upstream' ? 'bundled' : 'corpus'}`);
        console.log(`  Cleanup: ${cleanup ? 'will remove .aiwg source after copy' : 'skipped (--cleanup not set)'}`);
        return { exitCode: 0 };
      }

      await writeAiwgConfig(projectDir, config);
      console.log(`✓ Promoted '${positional}' → ${result.plan?.destination}`);
      if (cleanup) {
        console.log('  Source removed from .aiwg/');
        try {
          const { deployProjectQuickref, generateProjectQuickref, hasProjectQuickref } = await import('../../extensions/project-quickref.js');
          if (await hasProjectQuickref(projectDir)) {
            if (config.providers.length > 0) {
              for (const provider of config.providers) await deployProjectQuickref(projectDir, provider);
              console.log(`  Managed project quickref refreshed for: ${config.providers.join(', ')}.`);
            } else {
              await generateProjectQuickref(projectDir);
              console.log('  Managed project quickref generated; no providers are configured for deployment.');
            }
          } else {
            console.log('  Managed project quickref is now empty; run `aiwg doctor --project-local` to inspect deployed stale copies.');
          }
        } catch (error) {
          console.log(`  Managed project quickref refresh failed: ${(error as Error).message}`);
        }
      }
      return { exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, message: `promote failed: ${msg}` };
    }
  },
};

/**
 * New bundle handler — scaffolds a project-local bundle under the configured
 * AIWG artifact root with a valid manifest, starter artifact, and a
 * README that includes the identical-form portability reminder.
 *
 * Usage:
 *   aiwg new-bundle <name>                      # default: --type extension --starter skill
 *   aiwg new-bundle <name> --type addon
 *   aiwg new-bundle <name> --type framework --starter minimal
 *   aiwg new-bundle <name> --starter rule --description "Custom rule"
 *
 * @implements #1050
 */
export const newBundleHandler: CommandHandler = {
  id: 'new-bundle',
  name: 'New Bundle',
  description: 'Scaffold a project-local bundle under the configured AIWG artifact root',
  category: 'scaffolding',
  aliases: ['new-extension', 'new-addon', 'new-framework', 'new-plugin', 'new-provider'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const args = ctx.args;
    const positional = args.find(a => !a.startsWith('-'));
    if (!positional) {
      return {
        exitCode: 1,
        message: 'Error: bundle name required\n\nUsage: aiwg new-bundle <name> [--type extension|addon|framework|plugin|provider] [--starter skill|rule|agent|minimal] [--description "..."]',
      };
    }

    // Type can be inferred from the alias used to invoke (new-extension etc.)
    const aliasMap: Record<string, 'extension' | 'addon' | 'framework' | 'plugin' | 'provider'> = {
      'new-extension': 'extension',
      'new-addon': 'addon',
      'new-framework': 'framework',
      'new-plugin': 'plugin',
      'new-provider': 'provider',
    };
    const invoked = ctx.rawArgs[0] ?? '';
    const aliasType = aliasMap[invoked];

    const typeIdx = args.findIndex(a => a === '--type');
    const typeFlag = typeIdx >= 0 ? args[typeIdx + 1] : undefined;
    const type = (typeFlag ?? aliasType ?? 'extension') as 'extension' | 'addon' | 'framework' | 'plugin' | 'provider';
    if (!['extension', 'addon', 'framework', 'plugin', 'provider'].includes(type)) {
      return { exitCode: 1, message: `Error: --type must be one of extension|addon|framework|plugin|provider (got '${type}')` };
    }

    const starterIdx = args.findIndex(a => a === '--starter');
    const starter = starterIdx >= 0 ? (args[starterIdx + 1] as 'skill' | 'rule' | 'agent' | 'minimal') : undefined;
    if (starter && !['skill', 'rule', 'agent', 'minimal'].includes(starter)) {
      return { exitCode: 1, message: `Error: --starter must be one of skill|rule|agent|minimal (got '${starter}')` };
    }

    const descIdx = args.findIndex(a => a === '--description');
    const description = descIdx >= 0 ? args[descIdx + 1] : undefined;

    const dryRun = args.includes('--dry-run');

    const { scaffoldProjectLocalBundle } = await import('../../extensions/project-local-scaffold.js');

    try {
      const result = await scaffoldProjectLocalBundle({
        type,
        name: positional,
        description,
        starter,
        projectDir: ctx.cwd,
        dryRun,
      });

      if (result.alreadyExists) {
        return {
          exitCode: 1,
          message: `Refused: bundle already exists at ${result.bundlePath}. Remove it first or pick a different name.`,
        };
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would scaffold project-local ${type} '${positional}' at ${result.bundlePath}`);
        console.log('  Files that would be created:');
        for (const f of result.filesCreated) console.log(`    + ${f}`);
        console.log('');
        console.log('No files written. Re-run without --dry-run to create.');
        return { exitCode: 0 };
      }

      console.log(`✓ Scaffolded project-local ${type} '${positional}' at ${result.bundlePath}`);
      console.log('  Files created:');
      for (const f of result.filesCreated) console.log(`    + ${f}`);

      // #1085 — when the project blanket-ignores .aiwg/, the new bundle's
      // source would be silently dropped from version control. Detect and
      // self-heal idempotently.
      try {
        const { appendAiwgSourceTrackBlock } = await import(
          '../../extensions/project-local-gitignore.js'
        );
        const ig = await appendAiwgSourceTrackBlock(ctx.cwd);
        if (ig.added) {
          console.log('');
          console.log(`  → ${ig.reason}`);
          console.log('    .aiwg/{addons,extensions,frameworks,plugins,providers}/ now tracked by git.');
          console.log('    Generated state under .aiwg/ (working/, ralph/, research/, ...) stays ignored.');
        }
      } catch {
        // .gitignore management is best-effort; don't fail the scaffold
      }

      try {
        const { generateProjectQuickref } = await import('../../extensions/project-quickref.js');
        await generateProjectQuickref(ctx.cwd);
        console.log('  → Managed project quickref refreshed from discovered capabilities.');
      } catch (error) {
        console.log(`  → Managed project quickref refresh deferred: ${(error as Error).message}`);
      }

      // #1235 / #1758 — auto-rebuild the project graph and refresh the
      // Fortemi Core static cache so the new bundle is immediately
      // discoverable via top-level `aiwg discover` / `aiwg show`.
      // Best-effort: don't fail the scaffold if indexing hiccups.
      let indexedOk = false;
      let fortemiSyncedOk = false;
      try {
        const { buildIndex } = await import('../../artifacts/index-builder.js');
        await buildIndex(ctx.cwd, { graph: 'project', force: false, explicit: true });
        indexedOk = true;
        const { syncFortemiCoreIndex } = await import('../../artifacts/fortemi-core-sync.js');
        syncFortemiCoreIndex(ctx.cwd, { graph: 'project' });
        fortemiSyncedOk = true;
      } catch {
        // ignore — surface via next-steps hint instead
      }

      console.log('');
      console.log('Next steps:');
      console.log(`  1. Edit manifest.json (description, version, keywords)`);
      console.log(`  2. Customize the starter artifact under ${result.bundlePath}/`);
      if (indexedOk && fortemiSyncedOk) {
        console.log(`  3. Discoverable now via:  aiwg discover "${positional}"`);
      } else if (indexedOk) {
        console.log(`  3. Sync project search cache: aiwg index sync --graph project`);
        console.log(`     then:                       aiwg discover "${positional}"`);
      } else {
        console.log(`  3. Rebuild project index:  aiwg index build --graph project`);
        console.log(`     then sync search cache: aiwg index sync --graph project`);
        console.log(`     then:                   aiwg discover "${positional}"`);
      }
      console.log(`  4. Deploy:  aiwg use ${positional}`);
      console.log(`  5. Inspect: aiwg doctor --project-local`);
      console.log(`  6. When mature, promote:  aiwg promote ${positional}`);

      return { exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, message: `Error: ${msg}` };
    }
  },
};
