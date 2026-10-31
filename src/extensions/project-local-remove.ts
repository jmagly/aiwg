/**
 * Project-Local Bundle Remove
 *
 * Reverts a project-local bundle's deployed artifacts from provider paths
 * per the case table in `.aiwg/architecture/design-aiwg-remove-revert.md`
 * (#1048). Reads artifactHashes from the registry to detect pristine vs
 * mutated vs replaced files.
 *
 * Source under `.aiwg/<type>/<name>/` is NEVER deleted (load-bearing
 * invariant — `--force` does not change this).
 *
 * @design @.aiwg/architecture/design-aiwg-remove-revert.md
 * @implements #1037
 */

import { lstat, readdir, readFile, stat, unlink, rmdir } from 'fs/promises';
import { resolve, join, relative, dirname, isAbsolute, sep } from 'path';
import { deployedSkillRoots } from '../providers/deployed-skill-roots.js';
import { releaseSkillOwnership } from '../providers/skill-ownership.mjs';
import type { AiwgConfig, InstalledEntry } from '../config/aiwg-config.js';
import { appendProjectLocalActivity } from './project-local-activity.js';
import { sha256OfFileNormalized } from './managed-marker.js';
import { getProviderArtifactPathStrings } from '../providers/provider-definitions.js';

export type RemoveCase =
  | 'pristine'      // Case 1
  | 'mutated'       // Case 2
  | 'missing'       // Case 3
  | 'replaced'      // Case 4 (foreign content; not owned by this bundle)
  | 'permission'    // Case 5 (EACCES/EROFS)
  | 'unhashed';     // Older entry without artifactHashes — treat as Case 2

export interface ArtifactRevertOutcome {
  provider: string;
  /** Source-relative path (the key in artifactHashes). */
  artifactPath: string;
  /** Absolute path the deploy targeted. */
  deployedAbsPath: string;
  case: RemoveCase;
  /** Did we actually delete the file (or skip it)? */
  reverted: boolean;
  /** Free-form one-line message for output. */
  message: string;
}

export interface RemoveOptions {
  preserveRoots?: string[];
  /** Skip case-2 mutation prompt; revert mutated files. Never deletes source. */
  force?: boolean;
  /** Limit revert to this provider only. */
  provider?: string;
  /** Print plan; no filesystem changes, no registry mutation. */
  dryRun?: boolean;
  /** Revert files but leave the registry entry. */
  keepRegistry?: boolean;
  /** Programmatic confirmation hook for case 2; defaults to "abort". */
  confirmMutation?: (info: ArtifactRevertOutcome) => Promise<boolean> | boolean;
}

export interface RemoveResult {
  /** Was a project-local entry found in `installed`? */
  found: boolean;
  /** Per-artifact outcomes across all providers. */
  outcomes: ArtifactRevertOutcome[];
  /** Providers fully reverted (registry entry removed for each). */
  revertedProviders: string[];
  /** Providers with at least one skipped artifact (registry entry preserved for each). */
  partialProviders: string[];
  /** True when the bundle id matched a project-local entry, false when it should fall through to upstream remove. */
  isProjectLocal: boolean;
}

/**
 * Hash an artifact file with the managed-marker line stripped.
 *
 * Source files have no marker (it's deploy-time-injected); deployed files
 * do. Stripping the marker on both sides makes the hash insensitive to
 * the marker, which is the equivalence relation we actually want for
 * pristine/mutated/drift checks. See `managed-marker.ts` for the details.
 *
 * @implements #1086
 */
async function sha256Hex(absPath: string): Promise<string> {
  return sha256OfFileNormalized(absPath);
}

/**
 * Compute hashes for every artifact under a project-local bundle, keyed by
 * source-relative path (e.g., "rules/my-rule.md", "skills/x/SKILL.md").
 *
 * Artifact dirs scanned: agents/, commands/, skills/, rules/. Skill entries
 * use the SKILL.md inside the per-skill subdirectory; everything else is a
 * top-level .md file.
 */
export async function hashBundleArtifacts(
  bundleAbsPath: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  // Flat .md dirs
  for (const dir of ['agents', 'commands', 'rules'] as const) {
    const dirAbs = join(bundleAbsPath, dir);
    let entries: string[];
    try {
      entries = await readdir(dirAbs);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith('.md')) continue;
      if (e === 'README.md' || e === 'RULES-INDEX.md' || e === 'INDEX.md') continue;
      const fileAbs = join(dirAbs, e);
      try {
        out[`${dir}/${e}`] = await sha256Hex(fileAbs);
      } catch {
        // Read failures are non-fatal — skip the artifact
      }
    }
  }

  // Skill subdirs
  const skillsAbs = join(bundleAbsPath, 'skills');
  let skillEntries: string[];
  try {
    skillEntries = await readdir(skillsAbs);
  } catch {
    skillEntries = [];
  }
  for (const skill of skillEntries) {
    const skillDir = join(skillsAbs, skill);
    try {
      const st = await stat(skillDir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const skillMd = join(skillDir, 'SKILL.md');
    try {
      out[`skills/${skill}/SKILL.md`] = await sha256Hex(skillMd);
    } catch {
      // No SKILL.md — skip
    }
  }

  return out;
}

/**
 * Hash the provider-transformed files produced by a successful deployment.
 * The source hash map supplies the canonical inventory/key shape; values are
 * read from the first canonical provider path that exists.
 */
export async function hashDeployedBundleArtifacts(
  projectDir: string,
  provider: string,
  sourceHashes: Record<string, string>,
): Promise<Record<string, string>> {
  const deployed: Record<string, string> = {};
  for (const [sourceRel, sourceHash] of Object.entries(sourceHashes)) {
    // Keep the complete inventory if a provider path unexpectedly cannot be
    // resolved. Removal then fails safely instead of clearing the registry
    // while leaving an untracked provider artifact behind.
    deployed[sourceRel] = sourceHash;
    for (const candidate of candidateDeployedPaths(projectDir, provider, sourceRel)) {
      try {
        deployed[sourceRel] = await sha256Hex(candidate);
        break;
      } catch {
        // Try translated/provider-alternate paths before leaving it absent.
      }
    }
  }
  return deployed;
}

/** Resolve current provider hashes while preserving old registry entries. */
export function artifactHashesForProvider(
  entry: InstalledEntry,
  provider: string,
): Record<string, string> {
  return entry.deployedArtifactHashes?.[provider] ?? entry.artifactHashes ?? {};
}

/** Resolve a recorded source-relative artifact through the canonical provider
 * definition rather than assuming every artifact lives directly under the
 * provider prefix (#1869). Returned paths are absolute for both project- and
 * home-deploying providers. */
export function candidateDeployedPaths(
  projectDir: string,
  provider: string,
  sourceRel: string,
): string[] {
  const separator = sourceRel.indexOf('/');
  if (separator < 1) return [];
  const artifactType = sourceRel.slice(0, separator);
  if (!['agents', 'commands', 'skills', 'rules'].includes(artifactType)) return [];

  const paths = getProviderArtifactPathStrings(provider);
  const root = paths?.[artifactType as 'agents' | 'commands' | 'skills' | 'rules'];
  if (!root) return [];

  const tail = sourceRel.slice(separator + 1);
  const absoluteRoot = isAbsolute(root) ? root : resolve(projectDir, root);
  const candidates = [join(absoluteRoot, tail)];

  // Codex discovers project skills from the shared native `.agents/skills`
  // root while retaining `.codex` as its compatibility deployment surface.
  if (provider === 'codex' && artifactType === 'skills') {
    candidates.unshift(join(resolve(projectDir, '.agents', 'skills'), tail));
  }

  // Provider adapters may translate source extensions.
  if (provider === 'cursor' && artifactType === 'rules' && tail.endsWith('.md')) {
    candidates.push(join(absoluteRoot, `${tail.slice(0, -3)}.mdc`));
  }
  if (provider === 'codex' && artifactType === 'agents' && tail.endsWith('.md')) {
    candidates.push(join(absoluteRoot, `${tail.slice(0, -3)}.toml`));
  }
  return [...new Set(candidates)];
}

async function tryUnlink(absPath: string): Promise<{ deleted: boolean; permission?: boolean }> {
  try {
    await unlink(absPath);
    return { deleted: true };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { deleted: false };
    if (e.code === 'EACCES' || e.code === 'EROFS') return { deleted: false, permission: true };
    throw err;
  }
}

async function cleanupManagedSkillDirectory(absPath: string): Promise<void> {
  if (!absPath.endsWith('/SKILL.md')) return;
  const skillDir = dirname(absPath);
  await tryUnlink(join(skillDir, '.aiwg-managed'));
  try {
    await rmdir(skillDir);
  } catch {
    // Preserve directories containing any operator or provider-created files.
  }
}

async function classify(
  expectedHash: string | undefined,
  absPath: string,
): Promise<RemoveCase> {
  if (!expectedHash) return 'unhashed';
  try {
    await lstat(absPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'missing';
  }
  let actual: string;
  try {
    actual = await sha256Hex(absPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') return 'permission';
    return 'missing';
  }
  if (actual === expectedHash) return 'pristine';
  // Mutated vs replaced — detection requires reading the file's frontmatter
  // id and comparing to the bundle's artifact id. For this iteration we
  // conservatively treat all hash-differs as 'mutated'; the design's case-4
  // ("replaced by another bundle's artifact") is detected by registry-level
  // ownership lookup (see resolveOwnership below) rather than per-file id.
  return 'mutated';
}

/**
 * Look up which other installed bundle (if any) records this deployed-path
 * in its own registry entry. If found, the file belongs to another bundle —
 * Case 4 (replaced).
 */
function resolveOwnership(
  config: AiwgConfig,
  selfBundleId: string,
  provider: string,
  sourceRel: string,
): string | null {
  for (const [name, entry] of Object.entries(config.installed)) {
    if (name === selfBundleId) continue;
    if (entry.source !== 'project-local') continue;
    const hashes = artifactHashesForProvider(entry, provider);
    if (sourceRel in hashes) {
      // Same source-rel path claimed by another project-local bundle —
      // the deployed file (if present) is theirs, not ours.
      return name;
    }
  }
  return null;
}

/**
 * Remove a project-local bundle's deploys per the design at
 * `.aiwg/architecture/design-aiwg-remove-revert.md`.
 *
 * Pure function over (config, projectDir, opts). The caller is responsible
 * for persisting the returned (mutated) config.
 */
export async function removeProjectLocalBundle(
  config: AiwgConfig,
  projectDir: string,
  bundleId: string,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  const entry = config.installed[bundleId];
  const isProjectLocal = entry !== undefined && entry.source === 'project-local';

  if (!isProjectLocal) {
    return {
      found: false,
      outcomes: [],
      revertedProviders: [],
      partialProviders: [],
      isProjectLocal: false,
    };
  }

  const { force = false, provider: onlyProvider, dryRun = false, keepRegistry = false } = opts;
  const confirmMutation = opts.confirmMutation ?? (async () => false);

  const installedEntry = entry as InstalledEntry;
  const providers = Object.keys(installedEntry.deployedTo).filter(
    p => !onlyProvider || p === onlyProvider,
  );

  const outcomes: ArtifactRevertOutcome[] = [];
  const revertedProviders: string[] = [];
  const partialProviders: string[] = [];

  for (const provider of providers) {
    const artifactHashes = artifactHashesForProvider(installedEntry, provider);
    let providerHadSkip = false;

    // Receipts cover the complete transformed skill and support tree, including
    // retired skills no longer present in the source inventory.
    const receiptSkills = new Set<string>();
    const sourceRoot = installedEntry.localPath ? resolve(projectDir, installedEntry.localPath) : undefined;
    for (const root of deployedSkillRoots(projectDir, provider).filter(root => !opts.preserveRoots?.includes(root))) {
      for (const name of await readdir(root).catch(() => [] as string[])) {
        const skillDir = join(root, name);
        try { await readFile(join(skillDir, '.aiwg-manifest.json'), 'utf8'); } catch { continue; }
        receiptSkills.add(name);
        const removed = releaseSkillOwnership(skillDir, {
          frameworkSlug: bundleId,
          skillSource: sourceRoot ? join(sourceRoot, 'skills', name) : undefined,
          sourceRoot,
        }, { dryRun });
        if (removed === null) {
          // Unrelated receipts are outside this bundle's removal inventory.
          if (!Object.keys(artifactHashes).some(sourceRel => sourceRel.startsWith(`skills/${name}/`))) continue;
          providerHadSkip = true;
        }
        outcomes.push({ provider, artifactPath: `skills/${name}/SKILL.md`, deployedAbsPath: skillDir,
          case: removed === null ? 'replaced' : 'pristine', reverted: removed !== null && !dryRun,
          message: removed === null ? 'owned by another source — preserved' : dryRun
            ? '[dry-run] would release skill ownership' : 'released skill ownership; operator files preserved' });
      }
    }

    for (const sourceRel of Object.keys(artifactHashes)) {
      if (sourceRel.startsWith('skills/') && receiptSkills.has(sourceRel.split('/')[1])) continue;
      const owner = resolveOwnership(config, bundleId, provider, sourceRel);
      if (owner) {
        providerHadSkip = true;
        outcomes.push({
          provider,
          artifactPath: sourceRel,
          deployedAbsPath: '(other bundle)',
          case: 'replaced',
          reverted: false,
          message: `owned by '${owner}' — refusing to delete`,
        });
        if (!dryRun) {
          await appendProjectLocalActivity({
            event: 'remove-conflict',
            name: bundleId,
            type: installedEntry.localType ?? 'extension',
            summary: `${provider}:${sourceRel} owned by ${owner}`,
          });
        }
        continue;
      }

      const candidates = candidateDeployedPaths(projectDir, provider, sourceRel).filter(file => !opts.preserveRoots?.some(root => file === root || file.startsWith(`${root}${sep}`)));
      let resolvedAbs: string | null = null;
      let detectedCase: RemoveCase = 'missing';
      for (const c of candidates) {
        const k = await classify(artifactHashes[sourceRel], c);
        if (k !== 'missing') {
          resolvedAbs = c;
          detectedCase = k;
          break;
        }
      }
      if (!resolvedAbs) {
        // Pick the first candidate just so the outcome carries a path
        const fallback = candidates[0] ?? '(unknown)';
        providerHadSkip = true;
        outcomes.push({
          provider,
          artifactPath: sourceRel,
          deployedAbsPath: fallback,
          case: 'missing',
          reverted: false,
          message: candidates.length === 0
            ? 'provider artifact path unavailable — registry preserved'
            : 'recorded artifact not found at canonical provider path — registry preserved for retry',
        });
        continue;
      }

      // Cases
      if (detectedCase === 'pristine') {
        if (dryRun) {
          outcomes.push({ provider, artifactPath: sourceRel, deployedAbsPath: resolvedAbs, case: 'pristine', reverted: false, message: '[dry-run] would revert' });
        } else {
          const r = await tryUnlink(resolvedAbs);
          if (r.permission) {
            providerHadSkip = true;
            outcomes.push({ provider, artifactPath: sourceRel, deployedAbsPath: resolvedAbs, case: 'permission', reverted: false, message: 'permission denied' });
          } else {
            if (r.deleted) await cleanupManagedSkillDirectory(resolvedAbs);
            outcomes.push({ provider, artifactPath: sourceRel, deployedAbsPath: resolvedAbs, case: 'pristine', reverted: r.deleted, message: r.deleted ? 'reverted' : 'already absent' });
          }
        }
        continue;
      }

      if (detectedCase === 'mutated' || detectedCase === 'unhashed') {
        const allowDelete = force || (await confirmMutation({ provider, artifactPath: sourceRel, deployedAbsPath: resolvedAbs, case: detectedCase, reverted: false, message: 'mutation detected' }));
        if (!allowDelete) {
          providerHadSkip = true;
          outcomes.push({ provider, artifactPath: sourceRel, deployedAbsPath: resolvedAbs, case: detectedCase, reverted: false, message: 'mutation skipped (--force to override)' });
          if (!dryRun) {
            await appendProjectLocalActivity({
              event: 'remove-mutated',
              name: bundleId,
              type: installedEntry.localType ?? 'extension',
              summary: `${provider}:${sourceRel} skipped`,
            });
          }
          continue;
        }
        if (dryRun) {
          outcomes.push({ provider, artifactPath: sourceRel, deployedAbsPath: resolvedAbs, case: detectedCase, reverted: false, message: '[dry-run] would revert (mutation override)' });
          continue;
        }
        const r = await tryUnlink(resolvedAbs);
        if (r.permission) {
          providerHadSkip = true;
          outcomes.push({ provider, artifactPath: sourceRel, deployedAbsPath: resolvedAbs, case: 'permission', reverted: false, message: 'permission denied' });
        } else {
          if (r.deleted) await cleanupManagedSkillDirectory(resolvedAbs);
          outcomes.push({ provider, artifactPath: sourceRel, deployedAbsPath: resolvedAbs, case: detectedCase, reverted: r.deleted, message: r.deleted ? 'reverted (mutation overridden)' : 'already absent' });
        }
      }
    }

    if (providerHadSkip) {
      partialProviders.push(provider);
    } else {
      revertedProviders.push(provider);
    }

    // Mutate registry for fully-reverted providers
    if (!dryRun && !keepRegistry && !providerHadSkip) {
      delete installedEntry.deployedTo[provider];
      if (installedEntry.deployedArtifactHashes) {
        delete installedEntry.deployedArtifactHashes[provider];
        if (Object.keys(installedEntry.deployedArtifactHashes).length === 0) {
          delete installedEntry.deployedArtifactHashes;
        }
      }
    }
  }

  // Top-level remove activity entry
  if (!dryRun) {
    const summary = providers
      .map(p => {
        const reverted = outcomes.filter(o => o.provider === p && o.reverted).length;
        const skipped = outcomes.filter(o => o.provider === p && !o.reverted).length;
        return `${p}=${reverted} reverted${skipped > 0 ? `, ${skipped} skipped` : ''}`;
      })
      .join(', ');
    await appendProjectLocalActivity({
      event: force ? 'remove-force' : 'remove',
      name: bundleId,
      type: installedEntry.localType ?? 'extension',
      summary,
    });
  }

  // Drop the entire `installed` entry only when every provider fully reverted
  if (!dryRun && !keepRegistry && Object.keys(installedEntry.deployedTo).length === 0) {
    delete config.installed[bundleId];
  }

  // Note: source under .aiwg/<type>/<name>/ is NEVER touched.
  void relative;

  return {
    found: true,
    outcomes,
    revertedProviders,
    partialProviders,
    isProjectLocal: true,
  };
}
