// Shared provider migrations utilities.
import { fs, path } from './base-runtime.mjs';
import { MANAGED_MARKER_RE, MANIFEST_FILENAME, readSidecarManifest, writeSidecarManifest } from './base-files.mjs';


/**
 * Clean up old individually-deployed rule files from target directory.
 * Removes any .md files that are NOT RULES-INDEX.md.
 *
 * @param {string} rulesDir - Target rules directory
 * @param {object} opts - Options
 * @param {boolean} opts.dryRun - If true, log but don't delete
 * @returns {string[]} - List of removed (or would-be-removed) file paths
 */
/**
 * Remove stale rule files from a deploy directory before writing fresh ones.
 *
 * Per #1143 + #1117: addon deploys run as separate `deploy-agents.mjs`
 * invocations after the main framework, and the previous "wipe all non-index
 * .md before writing" behavior caused the main framework's rules to be
 * silently destroyed by every subsequent addon deploy (whether or not the
 * addon shipped any rules of its own).
 *
 * The fix: cleanup only fires when the operator explicitly asks via
 * `opts.cleanRules: true`. The deploy-time cleanup is replaced by a
 * dedicated `aiwg refresh --clean-rules` operator flow (follow-up issue).
 *
 * Existing callers that pass `incomingFiles: []` still get a no-op; existing
 * callers that pass nothing get the legacy (now-disabled) cleanup as a no-op
 * by default.
 *
 * @param {string} rulesDir
 * @param {object} opts
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.cleanRules] explicit opt-in to remove stale files
 * @param {string[]} [opts.incomingFiles] when cleanRules=true, only files NOT
 *   in this list are removed
 */
export function cleanupOldRuleFiles(rulesDir, opts = {}) {
  const { dryRun = false, cleanRules = false, incomingFiles } = opts;
  const removed = [];

  if (!fs.existsSync(rulesDir)) return removed;
  if (!cleanRules) return removed;
  if (Array.isArray(incomingFiles) && incomingFiles.length === 0) return removed;

  // Only `.md` rules are eligible for generic cleanup — `.mdc` (native Cursor
  // rules) and non-rule files (config.json, …) are preserved. AIWG's own legacy
  // `.md`→`.mdc` migration is handled explicitly by the Cursor provider's
  // deployRulesInline (marker-gated), not here, so operator `.mdc` stay safe.
  const incomingBasenames = new Set(
    Array.isArray(incomingFiles)
      ? incomingFiles.map((f) => path.basename(f))
      : []
  );

  // Ownership gate (#1627): only AIWG-managed rule files are eligible for
  // removal. A rule the operator dropped into the dir (no sidecar entry, no
  // `aiwg:managed` marker) is preserved even when cleanRules is on.
  const sidecarManaged = readSidecarManifest(rulesDir)?.managed || {};

  const entries = fs.readdirSync(rulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    if (entry.name === 'RULES-INDEX.md') continue;
    if (entry.name === 'RULES-ONDEMAND.md') continue; // generated on-demand index (#1675) — protected like RULES-INDEX
    if (incomingBasenames.has(entry.name)) continue;

    const filePath = path.join(rulesDir, entry.name);

    let owned = Object.prototype.hasOwnProperty.call(sidecarManaged, entry.name);
    if (!owned) {
      try {
        owned = MANAGED_MARKER_RE.test(fs.readFileSync(filePath, 'utf8'));
      } catch {
        owned = false; // unreadable → leave it alone
      }
    }
    if (!owned) continue; // user-authored rule — preserve

    removed.push(filePath);

    if (dryRun) {
      console.log(`[dry-run] would remove old rule: ${entry.name}`);
    } else {
      fs.unlinkSync(filePath);
      console.log(`removed old rule: ${entry.name}`);
    }
  }

  if (removed.length > 0) {
    console.log(`cleaned up ${removed.length} old rule file(s) from ${rulesDir}`);
  }

  return removed;
}


/**
 * Migrate commands directory by removing stale AIWG command files before
 * skills deployment.
 *
 * AIWG migrated from commands to skills. If old AIWG command files are left
 * in place alongside newly deployed skills, the provider TUI (e.g. Claude
 * Code's command palette) shows duplicate entries — one from the stale
 * command file and one from the skill. This removes those duplicates.
 *
 * Removal is bounded to AIWG-managed command files (#1627): a command the
 * operator authored (no sidecar entry, no `aiwg:managed` marker) is preserved.
 * Subdirectories and non-command files are left untouched. The directory is
 * removed only if it ends up empty after pruning AIWG files.
 *
 * Home-directory providers (codex, openclaw) are excluded by the caller: their
 * commands paths are shared across all projects and must not be touched.
 *
 * @param {string} commandsDir - Full path to the provider's commands directory
 * @param {object} opts
 * @param {boolean} opts.dryRun - Log but don't delete
 * @param {boolean} opts.skipCommandsMigration - User opted out; warn about duplicates instead
 * @returns {boolean} true if any AIWG command file was removed (or would be in dry-run)
 */
/**
 * Commands directories already warned about this process. The stale-command
 * condition belongs to the directory, not to each deployed framework/addon, so
 * `aiwg use all` must not repeat it once per unit (#2541).
 */
export const warnedCommandsDirs = new Set();


/**
 * AIWG-managed command filenames in a directory — sidecar entries or files
 * carrying the managed marker. Operator-authored commands and current
 * skill-command wrappers are excluded.
 */
export function listManagedCommandFiles(commandsDir) {
  let entries;
  try {
    entries = fs.readdirSync(commandsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sidecar = readSidecarManifest(commandsDir) || { managed: {} };
  const managed = sidecar.managed || {};
  const names = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    if (managed[entry.name]?.kind === 'skill-command') continue;
    let owned = Object.prototype.hasOwnProperty.call(managed, entry.name);
    if (!owned) {
      try {
        owned = MANAGED_MARKER_RE.test(fs.readFileSync(path.join(commandsDir, entry.name), 'utf8'));
      } catch {
        owned = false;
      }
    }
    if (owned) names.push(entry.name);
  }
  return names;
}


export function migrateCommandsDirectory(commandsDir, opts = {}) {
  const { dryRun = false, skipCommandsMigration = false, verbose = false, warnOnSkip = true } = opts;

  if (!fs.existsSync(commandsDir)) return false;

  const entries = fs.readdirSync(commandsDir, { withFileTypes: true });
  if (entries.length === 0) return false;

  if (skipCommandsMigration) {
    // Structural opt-outs (project-local addon bundles) skip the migration because
    // it does not apply to them, not because the operator declined it. Warning
    // there is noise, and it fired once per bundle (#2541).
    if (!warnOnSkip) return false;

    const rel = path.relative(process.cwd(), commandsDir);
    // The condition is a property of the directory, not of each deployed unit;
    // emit it once per run no matter how many units pass through.
    const warned = opts.warnedCommandsDirs || warnedCommandsDirs;
    if (warned.has(commandsDir)) return false;
    warned.add(commandsDir);

    const stale = listManagedCommandFiles(commandsDir);
    if (stale.length === 0) return false;

    console.warn(`\nWarning: commands migration skipped for ${rel}`);
    console.warn('  Duplicate entries may appear in the command palette because these old');
    console.warn('  AIWG command files overlap with newly deployed skills:');
    for (const name of stale) console.warn(`    ${path.join(rel, name)}`);
    console.warn('  Resolve automatically by re-running without --skip-commands-migration,');
    console.warn('  or remove them directly:');
    console.warn(`    rm ${stale.map((name) => path.join(rel, name)).join(' ')}`);
    return false;
  }

  // Bound removal to AIWG-managed command files; preserve operator files.
  const sidecar = readSidecarManifest(commandsDir) || { managed: {} };
  const managed = sidecar.managed || {};
  let sidecarDirty = false;
  const rel = path.relative(process.cwd(), commandsDir);

  const managedNames = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.md')) continue; // only command markdown files
    const filePath = path.join(commandsDir, entry.name);
    // Skill-command wrappers ARE the current skill surface, not legacy command
    // files superseded by it. Migrating them away deletes what the same deploy
    // just wrote — and on a kernel-only run, which does not re-translate, they
    // are never restored (#2507).
    if (managed[entry.name]?.kind === 'skill-command') continue;
    let owned = Object.prototype.hasOwnProperty.call(managed, entry.name);
    if (!owned) {
      try {
        owned = MANAGED_MARKER_RE.test(fs.readFileSync(filePath, 'utf8'));
      } catch {
        owned = false;
      }
    }
    if (owned) managedNames.push(entry.name);
  }

  if (managedNames.length === 0) return false;

  if (dryRun) {
    console.log(`[dry-run] would remove ${managedNames.length} AIWG command file(s) from ${rel}`);
    return true;
  }

  for (const name of managedNames) {
    try {
      fs.unlinkSync(path.join(commandsDir, name));
      if (Object.prototype.hasOwnProperty.call(managed, name)) {
        delete managed[name];
        sidecarDirty = true;
      }
      if (verbose) console.log(`  removed AIWG command file: ${name}`);
    } catch (err) {
      if (verbose) console.warn(`  Warning: could not remove ${name}: ${err.message}`);
    }
  }

  if (sidecarDirty) writeSidecarManifest(commandsDir, sidecar, dryRun);
  console.log(`  Removed ${managedNames.length} old AIWG command file(s) from ${rel} (now served as skills)`);

  // Remove the directory only if AIWG files were the only contents.
  try {
    const remaining = fs.readdirSync(commandsDir).filter((n) => n !== MANIFEST_FILENAME);
    if (remaining.length === 0) {
      fs.rmSync(commandsDir, { recursive: true, force: true });
    }
  } catch { /* non-fatal */ }

  return true;
}
