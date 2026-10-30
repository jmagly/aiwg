// Focused subcommand handlers preserving the public facade.
import type { HandlerResult } from "./types.js";
import { releaseSkillOwnership } from "../../providers/skill-ownership.mjs";
import { removeClaudeAttribution } from "../../extensions/claude-hooks-installer.js";
import { createHash } from "node:crypto";
import * as os from "node:os";
import { firstRemovePositional, parseRemoveProvider } from "./remove-options.js";
export async function removeUserScopeDeploy(args: ReadonlyArray<string>): Promise<HandlerResult> {
  const positional = firstRemovePositional(args);
  if (!positional) {
    return {
      exitCode: 1,
      message: 'Error: framework name required\n\nUsage: aiwg remove <framework> --scope user [--provider <p>] [--dry-run]',
    };
  }

  const dryRun = args.includes('--dry-run');
  const providerParse = parseRemoveProvider(args);
  if (providerParse.error) {
    return {
      exitCode: 1,
      message: `${providerParse.error}\n\nUsage: aiwg remove <framework> --scope user [--provider <p>] [--dry-run]`,
    };
  }
  const provider = providerParse.provider;

  const { readUserRegistry, removeUserDeploy } = await import('../../config/user-registry.js');
  const { USER_SCOPE_PATHS } = await import('../scope-resolver.js');
  const registry = await readUserRegistry();
  const entry = registry.installed[positional];
  if (!entry) {
    return {
      exitCode: 1,
      message: `Error: framework '${positional}' is not deployed at user scope.\n\nRun 'aiwg list --scope user' to see installed frameworks.`,
    };
  }

  const providersToRevert = provider ? [provider] : Object.keys(entry.deployedTo);
  if (provider && !entry.deployedTo[provider]) {
    return {
      exitCode: 1,
      message: `Error: framework '${positional}' is not deployed at user scope for provider '${provider}'.\n\nDeployed providers: ${Object.keys(entry.deployedTo).join(', ') || '(none)'}`,
    };
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const linesOut: string[] = [];
  if (dryRun) linesOut.push(`[dry-run] Plan for user-scope remove of '${positional}':`);
  else linesOut.push(`Removing user-scope mirror of '${positional}':`);

  const { resolveFrameworkDir } = await import('./use.js');
  const owner = resolveFrameworkDir(positional) ?? positional;
  let totalDeleted = 0;
  let conservativeFallbackUsed = false;

  for (const p of providersToRevert) {
    const userPaths = USER_SCOPE_PATHS[p];
    if (!userPaths) {
      linesOut.push(`  ⚠ ${p}: no user-scope paths registered — skipping (manual cleanup may be needed)`);
      continue;
    }

    // Cast through unknown to access the optional `entries` snapshot recorded
    // by the Cycle 3 mirror. Older registry entries won't have it.
    const providerEntry = entry.deployedTo[p] as unknown as {
      entries?: { agents?: string[]; commands?: string[]; skills?: string[]; rules?: string[]; behaviors?: string[] };
    };
    const recorded = providerEntry?.entries;

    if (!recorded) {
      // Pre-Cycle-3 entry: surface the deploy paths and let the operator
      // clean them up manually. We can't safely auto-delete because the dirs
      // are shared with other frameworks.
      conservativeFallbackUsed = true;
      const existingDirs = [
        { type: 'agents', path: userPaths.agents },
        { type: 'commands', path: userPaths.commands },
        { type: 'skills', path: userPaths.skills },
        { type: 'rules', path: userPaths.rules },
        { type: 'behaviors', path: userPaths.behaviors },
      ].filter(t => t.path);
      linesOut.push(`  ⚠ ${p}: registry entry has no per-artifact manifest (deployed before Cycle 3). Manual cleanup of these dirs may be needed:`);
      for (const t of existingDirs) {
        const stat = await fs.stat(t.path).catch(() => null);
        if (stat && stat.isDirectory()) {
          linesOut.push(`      - ${t.path}`);
        }
      }
      continue;
    }

    // Precise revert — walk the recorded entry names and delete each one
    // from its corresponding user-scope dir.
    const sets: Array<[string, string, string[] | undefined]> = [
      ['agents', userPaths.agents, recorded.agents],
      ['commands', userPaths.commands, recorded.commands],
      ['skills', userPaths.skills, recorded.skills],
      ['rules', userPaths.rules, recorded.rules],
      ['behaviors', userPaths.behaviors, recorded.behaviors],
    ];
    for (const [type, dir, names] of sets) {
      if (!dir || !names || names.length === 0) continue;
      let deletedHere = 0;
      let managed: Record<string, { hash?: string; owners?: string[] }> = {};
      if (type !== 'skills') {
        try { managed = JSON.parse(await fs.readFile(path.join(dir, '.aiwg-manifest.json'), 'utf8')).managed ?? {}; }
        catch { /* Legacy mirrors may have no digest receipt. */ }
      }
      for (const name of names) {
        const target = path.join(dir, name);
        const shared = Object.entries(registry.installed).some(([framework, installed]) => framework !== positional
          && (installed.deployedTo[p] as typeof providerEntry | undefined)?.entries?.[type as keyof NonNullable<typeof recorded>]?.includes(name));
        if (shared || managed[name]?.owners?.some(candidate => candidate !== owner)) {
          linesOut.push(`  · ${p} ${type}: preserve ${target} — shared with another installed framework`);
          continue;
        }
        if (type !== 'skills') {
          const digest = managed[name]?.hash;
          if (digest !== undefined) {
            const stat = await fs.lstat(target).catch(() => null);
            const bytes = stat?.isFile() ? await fs.readFile(target).catch(() => null) : null;
            if (!bytes || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== digest) {
              linesOut.push(`  · ${p} ${type}: preserve ${target} — modified or unverifiable managed file`);
              continue;
            }
          } else linesOut.push(`  ⚠ ${p} ${type}: ${target} — legacy manifest has no digest; ${dryRun ? 'would remove' : 'removing'} by recorded name`);
        }
        if (dryRun) {
          linesOut.push(`  · ${p} ${type}: ${target}`);
          deletedHere++;
          continue;
        }
        try {
          if (type === 'skills') {
            const released = releaseSkillOwnership(target, { frameworkSlug: owner });
            if (released === null) continue;
          } else {
            await fs.rm(target, { recursive: true, force: true });
          }
          deletedHere++;
          totalDeleted++;
        } catch (err) {
          linesOut.push(`  ⚠ ${p} ${type}: failed to remove ${target}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!dryRun && deletedHere > 0) {
        linesOut.push(`  ✓ ${p} ${type}: removed ${deletedHere} entry/entries from ${dir}`);
      } else if (dryRun) {
        linesOut.push(`    (${deletedHere} ${type} would be removed from ${dir})`);
      }
    }
  }

  if (!dryRun) {
    if (provider) {
      await removeUserDeploy({ framework: positional, provider });
    } else {
      await removeUserDeploy({ framework: positional });
    }
    if (providersToRevert.includes('claude') && !Object.values((await readUserRegistry()).installed).some(item => item.deployedTo.claude)) await removeClaudeAttribution(os.homedir());
    linesOut.push('');
    if (conservativeFallbackUsed) {
      linesOut.push('Registry updated. Some providers had no per-artifact manifest (pre-Cycle-3 deploys); inspect the dirs listed above and clean up manually if needed.');
    } else {
      linesOut.push(`Registry updated. ${totalDeleted} artifact entry/entries removed.`);
    }
  }

  return {
    exitCode: 0,
    message: linesOut.join('\n') + '\n',
  };
}
