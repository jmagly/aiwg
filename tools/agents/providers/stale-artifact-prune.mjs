/** Preserve projector-owned rules while pruning stale legacy flat artifacts. */
import fs from 'node:fs';
import path from 'node:path';
import { artifactStem, computeArtifactInventory, computeAllSkillNames, listMdFiles, listSkillDirs, pruneStaleAiwgFiles, resolveAiwgRoot } from './base.mjs';
import { importImpl } from '../../_resolve-impl.mjs';
const { deploymentOwner } = await importImpl(import.meta.url, 'providers/deployment-ownership.mjs');

/**
 * After a deploy, prune AIWG-managed flat artifacts (agents/commands/rules)
 * whose source no longer ships them — mirroring the skills holistic prune.
 *
 * Safety boundaries:
 *   - Runs ONLY for AIWG framework/addon deploys (default source = AIWG root,
 *     or `--source` under `<aiwgRoot>/agentic/code`). A named bundle pass
 *     instead compares only its own recorded outputs with its source tree,
 *     including project-local sources.
 *   - `pruneStaleAiwgFiles` itself only removes files whose AIWG
 *     receipt hash matches their bytes AND whose recorded owners no longer
 *     ship the stem. Without bundle identity, it uses the global source set.
 *     Any still-shipping recorded owner protects a shared path.
 *   - Aggregate-file paths (e.g. `AGENTS.md`) and unset paths are skipped.
 *
 * @param {object} provider loaded provider module
 * @param {string} target deploy target dir
 * @param {string} srcRoot effective deploy source
 * @param {object} opts deploy opts (dryRun/verbose/quiet + deploy flags)
 * @param {string|null} explicitSource the raw `--source` value (null when unset)
 */
/** Bundles whose deploy is itself the kernel-only bulk install. */
const BULK_INSTALL_BUNDLES = new Set(['all']);

/**
 * True when the kernel-only bulk install is the only thing this project has
 * deployed, so clearing leftover flat artifacts is a migration and not a
 * deletion of another bundle's surface (#2508).
 *
 * A project with no readable `.aiwg/aiwg.config` has no recorded owner, so the
 * pre-#152 migration cleanup still applies.
 */
export function bulkInstallOwnsFlatArtifacts(target) {
  let installed;
  try {
    const raw = fs.readFileSync(path.join(target, '.aiwg', 'aiwg.config'), 'utf8');
    installed = JSON.parse(raw)?.installed;
  } catch {
    return true;
  }
  if (!installed || typeof installed !== 'object') return true;
  return !Object.keys(installed).some(name => !BULK_INSTALL_BUNDLES.has(name));
}

export function pruneStaleAiwgArtifacts(provider, target, srcRoot, opts, explicitSource) {
  if (opts.copyMode ?? opts.copyStandardSkills) return;
  if (opts.skillsOnly && !opts.kernelOnly) return; // skills run their own prune in the provider

  const aiwgRoot = resolveAiwgRoot(srcRoot);
  if (!aiwgRoot && !opts.bundleOnly) return; // standalone deploy without an ownership scope

  // Gate: only framework/addon deploys are eligible. A default deploy (no
  // --source) sources from the AIWG root. An explicit --source is eligible
  // only when it lives under <aiwgRoot>/agentic/code (bundled fw/addon).
  if (explicitSource && !opts.bundleOnly) {
    const codeRoot = path.join(aiwgRoot, 'agentic', 'code');
    const rel = path.relative(codeRoot, path.resolve(explicitSource));
    const underCode = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!underCode) return; // project-local bundle / external source → skip
  }

  if (opts.kernelOnly) {
    // Kernel-only delivers skills and rules. The empty desired set below
    // applies only to bulk agents/commands left by
    // the pre-#152 bulk default, when the bulk install is the only thing this
    // project ever deployed.
    //
    // #2508: applying it unconditionally deleted every artifact a sibling
    // bundle owned — `aiwg use sdlc` followed by `aiwg use all` took
    // .claude/agents from 139 to 0. When another bundle is installed, it owns
    // this surface deliberately and the migration assumption does not hold.
    if (!bulkInstallOwnsFlatArtifacts(target)) {
      if (opts.verbose) {
        console.log('skip kernel-only flat prune: another installed bundle owns agents/commands/rules');
      }
      return;
    }
    for (const type of ['agents', 'commands']) {
      const relPath = provider.paths?.[type];
      if (!relPath || relPath.endsWith('.md')) continue;
      const destDir = path.isAbsolute(relPath) ? relPath : path.join(target, relPath);
      pruneStaleAiwgFiles(destDir, new Set(), {
        dryRun: opts.dryRun,
        verbose: opts.verbose,
        artifactExtensions: ['.md', '.mdc', '.toml'],
      });
    }
    return;
  }

  const typesThisRun = [];
  if (!opts.commandsOnly && !opts.rulesOnly) typesThisRun.push('agents');
  if (opts.deployCommands || opts.commandsOnly) typesThisRun.push('commands');
  if (opts.deployRules || opts.rulesOnly) typesThisRun.push('rules');

  for (const type of typesThisRun) {
    const relPath = provider.paths?.[type];
    if (!relPath) continue;                 // type not file-deployed by provider
    if (relPath.endsWith('.md')) continue;  // aggregate file (e.g. AGENTS.md)

    const onlyOwner = opts.bundleOnly ? deploymentOwner(opts) : undefined;
    const selectedStems = onlyOwner && new Set(listMdFiles(path.join(srcRoot, type)).map(file => artifactStem(path.basename(file))));
    const inventory = onlyOwner ? { stems: selectedStems, ownerStems: new Map([[onlyOwner, selectedStems]]) }
      : computeArtifactInventory(srcRoot, type);
    if (!inventory) continue;               // no global desired set → skip

    const destDir = path.isAbsolute(relPath) ? relPath : path.join(target, relPath);
    // Activation projection owns its complete selected rule set, including extensions.
    // Its transactional replacement already removes retired managed rule files.
    if (type === 'rules') {
      const receipt = path.join(destDir, '.aiwg-manifest.json');
      if (fs.existsSync(receipt) && JSON.parse(fs.readFileSync(receipt, 'utf8')).delivery) continue;
    }
    let skillCommandStems = null;
    if (type === 'commands') {
      skillCommandStems = onlyOwner
        ? new Set(listSkillDirs(path.join(srcRoot, 'skills')).map(file => path.basename(file)))
        : computeAllSkillNames(srcRoot);
    }
    const removed = pruneStaleAiwgFiles(destDir, inventory.stems, {
      ownerStems: inventory.ownerStems,
      onlyOwner,
      dryRun: opts.dryRun,
      verbose: opts.verbose,
      // Retire wrappers whose source skill no longer ships (#2511). Only the
      // command directory holds them; the kernel-only branch returns earlier,
      // so a bulk install still cannot touch wrappers it did not write.
      skillCommandStems,
    });
    if (removed.length > 0 && !opts.quiet) {
      console.log(`  Pruned: ${removed.length} stale AIWG ${type} file${removed.length === 1 ? '' : 's'}`);
    }
  }
}

