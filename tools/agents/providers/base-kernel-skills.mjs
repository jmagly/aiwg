// Shared provider kernel skills utilities.
import { fs, path } from './base-runtime.mjs';
import { parseFrontmatter } from './base-frontmatter.mjs';
import { ensureDir } from './base-files.mjs';
import { deploySkillDir, pruneMissingStandardSkills } from './base-skill-copy.mjs';


/**
 * Read a skill's SKILL.md frontmatter and return whether it is a
 * "kernel" skill — always-loaded, deploys to the platform's native
 * skills directory rather than the AIWG-namespaced one. Per epic
 * #1212. A skill opts in by setting `kernel: true` in its frontmatter.
 *
 * Note: `parseFrontmatter` keeps values as strings (no YAML coercion).
 * Accept both the string `"true"` and the boolean `true` so callers
 * are not surprised if a future parser upgrade returns booleans.
 */
export function isKernelSkill(skillDir) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return false;
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const { metadata } = parseFrontmatter(content);
  const v = metadata?.kernel;
  return v === true || v === 'true';
}


/**
 * Deploy skills with kernel-vs-standard routing (#1212/#1216/#1217).
 *
 * Partitions `skillDirs` into kernel skills (frontmatter `kernel: true`)
 * and standard skills.
 *
 * **Kernel skills** copy to `kernelDestDir` (platform-native dir,
 * always-loaded by the platform). Small set: currently 24 skills spanning
 * framework quickrefs, routing maps, and self-maintenance operations.
 *
 * **Standard skills** are NOT copied per-project (#1217). They live at
 * `$AIWG_ROOT/agentic/code/.../skills/<name>/` and `aiwg discover`
 * returns absolute paths anchored there. The agent reads them directly
 * via the `Read` tool — no per-project mirror, no stale-copy risk.
 * `standardDestDir` is retained as a fallback when `$AIWG_ROOT` is not
 * readable, and as the cleanup target for legacy `.aiwg/skills/`
 * directories from rc.13 and earlier deploys.
 *
 * @param skillDirs        absolute paths to source skill directories
 * @param standardDestDir  absolute path for standard skills (legacy
 *                         per-project mirror — used only as cleanup
 *                         target by default; populated if
 *                         `opts.copyStandardSkills` is true)
 * @param kernelDestDir    absolute path for kernel skills
 *                         (e.g., `.cursor/skills`); pass null/undefined
 *                         to disable kernel routing
 * @param opts             standard deploy opts forwarded to
 *                         `deploySkillDir`. New optional flags:
 *                         - `copyStandardSkills` (default: false) —
 *                           force per-project copy of standard skills
 *                           (used when $AIWG_ROOT is not readable from
 *                           the agent's working directory)
 *
 * @returns `{ kernel, standardCopied, prunedFromKernelDir,
 *             prunedFromStandardDir, prunedKernelFromStandardDir }`
 *             deployed/pruned counts
 *
 * Cleanup behavior:
 *   - Kernel dir: prune any AIWG-shaped skill whose name now belongs
 *     to the standard tier (rc.13 behavior, preserved).
 *   - Standard dir: when standard copies are NOT being deployed this
 *     run, prune any AIWG-shaped skill that exists under
 *     `standardDestDir`. These are legacy per-project mirrors from
 *     rc.13 deploys; the canonical source is now `$AIWG_ROOT`.
 *   - User-authored skills (no SKILL.md, or names not in our deploy
 *     manifest) survive untouched in both directories.
 */
export function deploySkillsWithKernelRouting(
  skillDirs,
  standardDestDir,
  kernelDestDir,
  opts,
) {
  // Caller opts in via `opts.copyStandardSkills` (set by `--copy-all`
  // CLI flag, #1219). Default (#1217) is no-copy: standard skills stay
  // at their source path under $AIWG_ROOT and are reached via the
  // artifact index.
  const copyStandardSkills = opts?.copyStandardSkills === true;

  const kernel = [];
  const standard = [];
  for (const dir of skillDirs) {
    if (kernelDestDir && isKernelSkill(dir)) kernel.push(dir);
    else standard.push(dir);
  }

  // Names of skills in the deploy manifest — bound the cleanup to
  // names AIWG manages so user-authored content survives.
  const standardNames = new Set(standard.map(p => path.basename(p)));
  const allSkillNames = new Set([...standardNames, ...kernel.map(p => path.basename(p))]);

  if (kernel.length > 0 && kernelDestDir) {
    ensureDir(kernelDestDir, opts?.dryRun);
    for (const dir of kernel) deploySkillDir(dir, kernelDestDir, opts);
  }

  // Standard tier copy is OFF by default (#1217). Only fires when the
  // operator explicitly opts in via `copyStandardSkills` — typically
  // because $AIWG_ROOT isn't readable from the agent's working dir.
  let standardCopied = 0;
  if (copyStandardSkills && standard.length > 0) {
    ensureDir(standardDestDir, opts?.dryRun);
    for (const dir of standard) {
      deploySkillDir(dir, standardDestDir, opts);
      standardCopied++;
    }
  }

  // A skill promoted from standard → kernel may still have an older managed
  // copy in the opt-in standard mirror. Remove that duplicate even when
  // --copy-all remains enabled; otherwise providers that recursively scan
  // both tiers can surface the same skill twice after a tier transition.
  let prunedKernelFromStandardDir = 0;
  if (
    standardDestDir &&
    fs.existsSync(standardDestDir) &&
    !opts?.dryRun &&
    kernel.length > 0
  ) {
    const kernelNames = new Set(kernel.map(p => path.basename(p)));
    for (const entry of fs.readdirSync(standardDestDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !kernelNames.has(entry.name)) continue;
      const target = path.join(standardDestDir, entry.name);
      const skillMd = path.join(target, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const marker = path.join(target, '.aiwg-managed');
      let managed = fs.existsSync(marker);
      if (!managed) {
        try {
          managed = /^\s*namespace:\s*["']?aiwg["']?\s*$/m.test(
            parseFrontmatter(fs.readFileSync(skillMd, 'utf8')).frontmatter ?? '',
          );
        } catch { /* preserve unreadable/operator-owned content */ }
      }
      if (!managed) continue;
      fs.rmSync(target, { recursive: true, force: true });
      prunedKernelFromStandardDir++;
      if (opts?.verbose) console.log(`pruned promoted kernel from standard dir: ${entry.name}`);
    }
  }

  // Kernel-dir cleanup: prune skills whose name moved to the standard
  // tier (rc.13 logic). Holistic cleanup of orphaned skills (renamed or
  // removed sources) happens in a separate post-all-deploys step
  // (`pruneStaleAiwgSkills`) — running per-call here would race because
  // `deploySkills` may be invoked multiple times in one orchestration.
  let prunedFromKernelDir = 0;
  if (kernelDestDir && fs.existsSync(kernelDestDir) && !opts?.dryRun) {
    for (const entry of fs.readdirSync(kernelDestDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(kernelDestDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      if (!standardNames.has(entry.name)) continue;
      const target = path.join(kernelDestDir, entry.name);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        prunedFromKernelDir++;
        if (opts?.verbose) console.log(`pruned legacy from kernel dir: ${entry.name}`);
      } catch (err) {
        if (opts?.verbose) console.warn(`Warning: could not prune ${target}: ${err.message}`);
      }
    }
  }

  // Standard-dir cleanup (#1217): when we're NOT copying standard
  // skills, anything AIWG-named under standardDestDir is a legacy
  // mirror from a rc.13-or-earlier deploy. Prune to clean up.
  let prunedFromStandardDir = pruneMissingStandardSkills(standardDestDir, opts);
  if (
    !copyStandardSkills &&
    standardDestDir &&
    fs.existsSync(standardDestDir) &&
    !opts?.dryRun
  ) {
    for (const entry of fs.readdirSync(standardDestDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(standardDestDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      // Only prune skills AIWG manages — bound by the deploy manifest.
      if (!allSkillNames.has(entry.name)) continue;
      const target = path.join(standardDestDir, entry.name);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        prunedFromStandardDir++;
        if (opts?.verbose) console.log(`pruned legacy from standard dir: ${entry.name}`);
      } catch (err) {
        if (opts?.verbose) console.warn(`Warning: could not prune ${target}: ${err.message}`);
      }
    }
    // Try to remove the now-empty standard dir + its parent .aiwg/
    // wrapper if both end up empty. Best-effort.
    try {
      const remaining = fs.readdirSync(standardDestDir);
      if (remaining.length === 0) {
        fs.rmdirSync(standardDestDir);
        const aiwgWrapper = path.dirname(standardDestDir);
        if (path.basename(aiwgWrapper) === '.aiwg') {
          const wrapperRemaining = fs.readdirSync(aiwgWrapper);
          if (wrapperRemaining.length === 0) fs.rmdirSync(aiwgWrapper);
        }
      }
    } catch { /* non-fatal */ }
  }

  return {
    kernel: kernel.length,
    standardCopied,
    prunedFromKernelDir,
    prunedFromStandardDir,
    prunedKernelFromStandardDir,
  };
}


/**
 * Compute the global desired-kernel set by walking the entire AIWG
 * source tree (frameworks + addons), regardless of which deploy mode
 * is in flight. Used by `pruneStaleAiwgSkills` so cleanup never races
 * with sibling deploy invocations (`aiwg use` runs `deploy-agents.mjs`
 * multiple times — once per framework, once per addon batch).
 *
 * @param {string} srcRoot AIWG repo / install root
 * @returns {string[]|null} basenames of every source skill dir whose
 *   SKILL.md frontmatter has `kernel: true`, or `null` when no AIWG
 *   framework/addon tree can be located. A `null` return signals the
 *   caller (`pruneStaleAiwgSkills`) to SKIP pruning rather than treat an
 *   empty set as "delete every AIWG skill" (#123). Mirrors the contract of
 *   `computeAllArtifactBasenames` (#1627).
 */
export function computeAllKernelNames(srcRoot) {
  const hasAiwgTree = (dir) =>
    fs.existsSync(path.join(dir, 'agentic', 'code', 'frameworks')) &&
    fs.existsSync(path.join(dir, 'agentic', 'code', 'addons'));
  const isRootOrSourceDescendant = (candidate, original) => {
    const root = path.resolve(candidate);
    const source = path.resolve(original);
    const agenticCode = path.join(root, 'agentic', 'code');
    return source === root || source === agenticCode || source.startsWith(`${agenticCode}${path.sep}`);
  };

  // Prefer an explicit AIWG_ROOT, but only when it actually points at a real
  // AIWG tree — a stale/bogus env value must not silently yield an empty
  // desired set. Otherwise walk up from srcRoot (the caller may pass an
  // addon/framework/project-local-bundle path, not the install root).
  let aiwgRoot = null;
  if (process.env.AIWG_ROOT && hasAiwgTree(process.env.AIWG_ROOT)) {
    aiwgRoot = process.env.AIWG_ROOT;
  } else {
    let cur = path.resolve(srcRoot);
    for (let i = 0; i < 8; i++) {
      if (hasAiwgTree(cur) && isRootOrSourceDescendant(cur, srcRoot)) { aiwgRoot = cur; break; }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  // No AIWG framework/addon tree found — e.g. deploying a project-local
  // bundle with AIWG_ROOT unset. Return null so the prune is skipped.
  if (!aiwgRoot) return null;

  const names = new Set();
  const roots = [
    path.join(aiwgRoot, 'agentic', 'code', 'frameworks'),
    path.join(aiwgRoot, 'agentic', 'code', 'addons'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const componentEntry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!componentEntry.isDirectory()) continue;
      const skillsDir = path.join(root, componentEntry.name, 'skills');
      if (!fs.existsSync(skillsDir)) continue;
      for (const skillEntry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!skillEntry.isDirectory()) continue;
        const fullPath = path.join(skillsDir, skillEntry.name);
        if (isKernelSkill(fullPath)) names.add(skillEntry.name);
      }
    }
  }
  return Array.from(names);
}


/**
 * Holistic post-deploy cleanup of stale AIWG-managed skills.
 *
 * Run this AFTER all `deploySkills` invocations have completed for a
 * given provider so the desired-name set reflects every kernel skill
 * deployed across all frameworks/addons. Per-call cleanup races because
 * `deploySkills` may be invoked multiple times in one orchestration —
 * this function does the cleanup once at the end.
 *
 * Identifies AIWG-managed skills via:
 *   1. `.aiwg-managed` marker file (preferred — set by `deploySkillDir`)
 *   2. Frontmatter `namespace: aiwg` (migration fallback for pre-marker
 *      deploys; stops firing after one redeploy)
 *
 * Bounded to entries identified above, so user-authored skills next to
 * AIWG-managed ones are never touched.
 *
 * @param {string} kernelDestDir absolute path to the platform's kernel
 *   skills dir (e.g. `<project>/.claude/skills/`)
 * @param {string[]|null} desiredKernelNames names of every kernel skill that
 *   SHOULD remain (basenames of source dirs). When `null` (no AIWG tree
 *   located — see `computeAllKernelNames`), pruning is skipped entirely so a
 *   project-local-bundle deploy without AIWG_ROOT never empties the kernel
 *   skills directory (#123).
 * @param {object} opts `{ dryRun, verbose, artifactExtensions }`
 * @returns {number} count of pruned entries
 */
export function pruneStaleAiwgSkills(kernelDestDir, desiredKernelNames, opts = {}) {
  if (!kernelDestDir || !fs.existsSync(kernelDestDir)) return 0;
  // No global desired set — skip pruning rather than delete everything (#123).
  if (desiredKernelNames == null) return 0;
  if (opts.dryRun) return 0;
  const desired = new Set(desiredKernelNames);
  let pruned = 0;
  for (const entry of fs.readdirSync(kernelDestDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (desired.has(entry.name)) continue;

    const skillMd = path.join(kernelDestDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;

    const marker = path.join(kernelDestDir, entry.name, '.aiwg-managed');
    let isAiwgManaged = fs.existsSync(marker);
    if (!isAiwgManaged) {
      try {
        const content = fs.readFileSync(skillMd, 'utf8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch && /^\s*namespace:\s*["']?aiwg["']?\s*$/m.test(fmMatch[1])) {
          isAiwgManaged = true;
        }
      } catch { /* unreadable — leave alone */ }
    }
    if (!isAiwgManaged) continue;

    try {
      fs.rmSync(path.join(kernelDestDir, entry.name), { recursive: true, force: true });
      pruned++;
      if (opts.verbose) console.log(`pruned stale AIWG skill: ${entry.name}`);
    } catch (err) {
      if (opts.verbose) console.warn(`Warning: could not prune ${entry.name}: ${err.message}`);
    }
  }
  return pruned;
}
