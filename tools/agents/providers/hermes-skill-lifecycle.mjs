/** Preserve Hermes curator registration and migrate the legacy skill directory. */
import fs from 'node:fs';
import path from 'node:path';
export function createHermesSkillLifecycle({ getHermesHome, paths, kernelSkillsPath }) {
/**
 * Hermes v0.12.0+ ships an autonomous Curator (`agent/curator.py`) that
 * grades and archives skills on a 7-day cycle. Skills are excluded from
 * archival if either:
 *   (a) they appear in `~/.hermes/skills/.bundled_manifest` (one name per
 *       line, format `name:tag`), or
 *   (b) their path's first component starts with `.` (verified at
 *       `tools/skill_usage.py:241-243`).
 *
 * AIWG standard skills under `~/.hermes/skills/.aiwg/...` are protected
 * by (b) automatically. AIWG kernel skills land at the top level
 * (`~/.hermes/skills/<name>/SKILL.md`) and need explicit (a) registration.
 *
 * This function writes/updates the bundled manifest with the kernel-skill
 * names AIWG owns. Idempotent: existing entries (from Hermes's own bundle
 * or other tools) are preserved.
 */
function updateBundledManifest(kernelSkillNames, opts) {
  const { dryRun, quiet } = opts;
  const manifestPath = path.join(opts.kernelSkillsPath || kernelSkillsPath, '.bundled_manifest');
  const aiwgTag = 'aiwg-managed';

  // Read existing manifest (if any) and split into "ours" vs "theirs"
  let existing = '';
  try {
    existing = fs.readFileSync(manifestPath, 'utf-8');
  } catch {
    existing = '';
  }
  const theirs = [];
  for (const rawLine of existing.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.endsWith(`:${aiwgTag}`)) continue;  // ours — drop, will re-add below
    theirs.push(line);
  }
  const ours = kernelSkillNames.map((n) => `${n}:${aiwgTag}`);

  // Stable order: theirs first (preserve operator/Hermes-bundled order), then ours
  const merged = [...theirs, ...ours].join('\n') + '\n';

  if (dryRun) {
    if (!quiet) {
      console.log(`  [curator] [dry-run] Would write ${manifestPath} with ${ours.length} AIWG kernel + ${theirs.length} preserved entries`);
    }
    return;
  }

  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, merged, 'utf-8');
    if (!quiet) {
      console.log(`  [curator] Bundled manifest updated: ${ours.length} AIWG kernel skills protected (preserved ${theirs.length} pre-existing entries)`);
    }
  } catch (err) {
    if (!quiet) {
      console.log(`  [curator] Warning: could not write bundled manifest: ${err.message}`);
    }
  }
}

// ============================================================================
// Legacy skill path migration (#1316 / S5)
// ============================================================================

/**
 * Remove the legacy `~/.hermes/.aiwg/skills/` directory if it exists and the
 * new path `~/.hermes/skills/.aiwg/` is populated with AIWG content.
 *
 * Idempotent: re-running after migration is a no-op.
 *
 * Safety:
 *   - Only removes when the new path exists and contains files
 *   - Skips removal if the new path is empty (avoids losing skills during
 *     an in-progress deploy where the new path hasn't been written yet)
 *   - Operates only on the documented legacy path — never touches user-managed
 *     directories under ~/.hermes/
 */
function migrateLegacySkillPath(opts) {
  if (opts.copyMode ?? opts.copyStandardSkills) return;
  const { dryRun, quiet } = opts;
  // Resolve through the same HERMES_HOME contract as every other path in
  // this provider (env var first, platform default otherwise): with
  // HERMES_HOME set, the legacy tree lives under that root — never under
  // the process home directory.
  const legacyPath = opts.hermesLegacySkills || path.join(getHermesHome(), '.aiwg', 'skills');
  const newPath = paths.skills;

  let legacyExists = false;
  try {
    legacyExists = fs.statSync(legacyPath).isDirectory();
  } catch {
    return; // no legacy path — nothing to migrate
  }
  if (!legacyExists) return;

  // Sanity: new path must exist and be non-empty before we remove the legacy one
  let newPopulated = false;
  try {
    const entries = fs.readdirSync(newPath);
    newPopulated = entries.length > 0;
  } catch {
    newPopulated = false;
  }

  if (!newPopulated) {
    if (!quiet) {
      console.log(`  [migrate] Legacy skills detected at ${legacyPath}; new path not yet populated. Skipping cleanup until next deploy.`);
    }
    return;
  }

  if (dryRun) {
    console.log(`  [migrate] [dry-run] Would remove legacy skill path: ${legacyPath}`);
    return;
  }

  try {
    fs.rmSync(legacyPath, { recursive: true, force: true });
    // Also remove the empty parent if it's now empty
    const parent = path.dirname(legacyPath);
    try {
      const remaining = fs.readdirSync(parent);
      if (remaining.length === 0) {
        fs.rmdirSync(parent);
      }
    } catch {
      // parent removal is best-effort
    }
    if (!quiet) {
      console.log(`  [migrate] Removed legacy skill path: ${legacyPath}`);
    }
  } catch (err) {
    if (!quiet) {
      console.log(`  [migrate] Warning: could not remove legacy path ${legacyPath}: ${err.message}`);
    }
  }
}

return { updateBundledManifest, migrateLegacySkillPath };
}
