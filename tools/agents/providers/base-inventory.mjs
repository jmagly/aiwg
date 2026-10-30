// Shared provider inventory utilities.
import { fs, path } from './base-runtime.mjs';
import { collectFrameworkArtifacts } from './base-framework-discovery.mjs';
import { getAddonAgentFiles, getAddonCommandFiles } from './base-addon-discovery.mjs';
import { getAddonRuleFiles } from './base-rule-index.mjs';
import { MANAGED_MARKER_RE, MANIFEST_FILENAME, readSidecarManifest, writeSidecarManifest } from './base-files.mjs';


// ============================================================================
// Flat-File Stale-Artifact Prune (agents / commands / rules) — #1627
// ============================================================================

/**
 * Reduce a deployed artifact filename to a provider-extension-agnostic stem.
 *
 * Different providers emit the same source rule/agent/command under different
 * extensions (`.md`, `.mdc`, `.agent.md`, `.prompt.md`, `.instructions.md`).
 * Matching by stem lets the stale-prune compare a source basename
 * (`foo.md` → `foo`) against any provider's on-disk form (`foo.agent.md` →
 * `foo`) without hard-coding the per-provider extension map.
 *
 * Strips a trailing `.md`/`.mdc`, then a secondary copilot-style
 * `.agent`/`.prompt`/`.instructions` qualifier.
 *
 * @param {string} name basename
 * @returns {string} extension-agnostic stem
 */
export function artifactStem(name) {
  return String(name)
    .replace(/\.(md|mdc)$/i, '')
    .replace(/\.(agent|prompt|instructions)$/i, '');
}


/**
 * Compute the global set of source-basename stems AIWG ships for a flat
 * artifact type, across ALL frameworks and addons (mode-independent).
 *
 * Used as the "desired" set by `pruneStaleAiwgFiles`. Mode independence is
 * deliberate and mirrors `computeAllKernelNames` for skills: `aiwg use sdlc`
 * must not prune a marketing agent that a prior `aiwg use all` deployed and
 * that is still a valid AIWG artifact. Only artifacts whose source no longer
 * exists ANYWHERE in the tree (renamed/removed) fall out of this set and
 * become prune-eligible.
 *
 * Anchors to the AIWG root (resolved by walking up from `srcRoot` for the
 * `agentic/code/frameworks` + `agentic/code/addons` pair, or `AIWG_ROOT`),
 * NOT the raw `srcRoot`. This matters because `deploy-agents.mjs` can be
 * invoked with `--source <project-local-bundle>`; computing the desired set
 * against a bundle dir would be empty and make every AIWG artifact look stale.
 * Returns `null` when no AIWG framework/addon tree is found — the caller MUST
 * then skip pruning (a bundle-only deploy has no global desired set).
 *
 * @param {string} srcRoot AIWG repo / install root (or a subdir of it)
 * @param {'agents'|'commands'|'rules'} type artifact type
 * @returns {Set<string>|null} stems of every source file of that type, or null
 *   if the AIWG framework/addon tree can't be located
 */
export function computeAllArtifactBasenames(srcRoot, type) {
  const aiwgRoot = resolveAiwgRoot(srcRoot);
  if (!aiwgRoot) return null;

  const stems = new Set();
  const add = (files) => {
    for (const f of files) stems.add(artifactStem(path.basename(f)));
  };

  const frameworkArtifacts = collectFrameworkArtifacts(aiwgRoot, 'all', {
    includeAgents: type === 'agents',
    includeCommands: type === 'commands',
    includeRules: type === 'rules',
    includeSkills: false,
    recursiveCommands: true,
  });

  if (type === 'agents') {
    add(frameworkArtifacts.agents);
    // Soul companions live alongside agents and are deployed with them —
    // keep their stems in the desired set so the prune never removes them.
    add(frameworkArtifacts.souls || []);
    add(getAddonAgentFiles(aiwgRoot, [], { includeExplicit: true }));
  } else if (type === 'commands') {
    add(frameworkArtifacts.commands);
    add(getAddonCommandFiles(aiwgRoot, [], { includeExplicit: true }));
  } else if (type === 'rules') {
    add(frameworkArtifacts.rules);
    add(getAddonRuleFiles(aiwgRoot, [], { includeExplicit: true }));
  }

  return stems;
}


/**
 * Resolve the AIWG install/repo root from a possibly-nested srcRoot.
 *
 * Mirrors the walk-up logic in `computeAllKernelNames`: honor `AIWG_ROOT`,
 * else climb up to 8 levels looking for the directory that holds BOTH
 * `agentic/code/frameworks` and `agentic/code/addons`. Returns `null` when
 * no such root is found (e.g. a standalone project-local bundle).
 *
 * @param {string} srcRoot
 * @returns {string|null}
 */
export function resolveAiwgRoot(srcRoot) {
  const hasTree = (dir) =>
    fs.existsSync(path.join(dir, 'agentic', 'code', 'frameworks')) &&
    fs.existsSync(path.join(dir, 'agentic', 'code', 'addons'));
  const isRootOrSourceDescendant = (candidate, original) => {
    const root = path.resolve(candidate);
    const source = path.resolve(original);
    const agenticCode = path.join(root, 'agentic', 'code');
    return source === root || source === agenticCode || source.startsWith(`${agenticCode}${path.sep}`);
  };

  if (process.env.AIWG_ROOT && hasTree(process.env.AIWG_ROOT)) {
    return process.env.AIWG_ROOT;
  }
  let cur = path.resolve(srcRoot);
  for (let i = 0; i < 8; i++) {
    if (hasTree(cur) && isRootOrSourceDescendant(cur, srcRoot)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}


/**
 * Names of every skill AIWG ships, kernel and standard alike (#2511).
 *
 * `computeAllKernelNames` filters to kernel skills, but skill-command wrappers
 * are generated from both tiers, so retiring an orphaned wrapper needs the full
 * set. Anchored to the AIWG root rather than `srcRoot` for the same reason
 * `computeAllArtifactBasenames` is: a bundle-scoped deploy must not produce an
 * empty desired set and retire everything.
 *
 * @param {string} srcRoot AIWG repo / install root (or a subdir of it)
 * @returns {Set<string>|null} skill directory names, or null when no AIWG tree
 *   is found — callers MUST then skip pruning.
 */
export function computeAllSkillNames(srcRoot) {
  const aiwgRoot = resolveAiwgRoot(srcRoot);
  if (!aiwgRoot) return null;

  const names = new Set();
  for (const group of ['frameworks', 'addons']) {
    const root = path.join(aiwgRoot, 'agentic', 'code', group);
    if (!fs.existsSync(root)) continue;
    for (const component of fs.readdirSync(root, { withFileTypes: true })) {
      if (!component.isDirectory()) continue;
      const skillsDir = path.join(root, component.name, 'skills');
      if (!fs.existsSync(skillsDir)) continue;
      for (const skill of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (skill.isDirectory()) names.add(skill.name);
      }
    }
  }
  return names;
}


/**
 * Holistic post-deploy prune of stale AIWG-managed flat artifacts
 * (agents / commands / rules). The flat-file analogue of
 * `pruneStaleAiwgSkills`.
 *
 * Removes a file from `destDir` only when ALL hold:
 *   1. It has an allowed deployed-artifact extension (`.md` / `.mdc` by
 *      default; callers may include `.toml`), is not `RULES-INDEX.md`,
 *      and not the sidecar manifest.
 *   2. Its stem is NOT in `desiredStems` (the source no longer ships it).
 *   3. It carries an AIWG ownership signal — either a `.aiwg-manifest.json`
 *      sidecar entry, or an in-file `aiwg:managed` marker.
 *
 * User-authored files (no ownership signal) and current AIWG artifacts (stem
 * in the desired set) are never touched. Pruned files also have their sidecar
 * entry dropped so the manifest stays accurate.
 *
 * Safe to call on every deploy invocation: `desiredStems` is the global
 * (mode-independent) source set, so sibling-framework files are never
 * collateral.
 *
 * @param {string} destDir absolute path to the provider artifact dir
 * @param {Set<string>|string[]} desiredStems stems that should remain
 * @param {object} opts `{ dryRun, verbose }`
 * @returns {string[]} removed (or would-be-removed) file paths
 */
export function pruneStaleAiwgFiles(destDir, desiredStems, opts = {}) {
  const { dryRun = false, verbose = false } = opts;
  const artifactExtensions = opts.artifactExtensions || ['.md', '.mdc'];
  // When supplied, skill-command wrappers are retired against the set of skills
  // that still exist rather than exempted outright (#2511). `null`/absent keeps
  // the blanket exemption, so callers without a skill inventory cannot retire a
  // wrapper by accident.
  const skillCommandStems = opts.skillCommandStems instanceof Set
    ? opts.skillCommandStems
    : Array.isArray(opts.skillCommandStems)
      ? new Set(opts.skillCommandStems)
      : null;
  const removed = [];
  if (!destDir || !fs.existsSync(destDir)) return removed;

  const desired = desiredStems instanceof Set ? desiredStems : new Set(desiredStems);
  const sidecar = readSidecarManifest(destDir) || { managed: {} };
  const managed = sidecar.managed || {};
  let sidecarDirty = false;

  let entries;
  try {
    entries = fs.readdirSync(destDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === MANIFEST_FILENAME) continue;
    if (name === 'RULES-INDEX.md') continue;
    if (name === 'RULES-ONDEMAND.md') continue; // generated on-demand index (#1673)
    const lower = name.toLowerCase();
    if (!artifactExtensions.some(extension => lower.endsWith(extension))) continue;

    if (desired.has(artifactStem(name))) continue;

    // Skill-command wrappers are named after skills, not command sources, so
    // they are absent from the command desired set by construction — pruning
    // them against it would delete wrappers the same deploy just wrote (#2507).
    // They are retired against the skill inventory instead, when one is given
    // (#2511); without one they stay exempt.
    if (managed[name]?.kind === 'skill-command') {
      if (!skillCommandStems || skillCommandStems.has(artifactStem(name))) continue;
    }

    // Ownership gate — never delete a file AIWG didn't deploy.
    let owned = Object.prototype.hasOwnProperty.call(managed, name);
    if (!owned) {
      try {
        owned = MANAGED_MARKER_RE.test(fs.readFileSync(path.join(destDir, name), 'utf8'));
      } catch {
        owned = false; // unreadable → leave it alone
      }
    }
    if (!owned) continue;

    const target = path.join(destDir, name);
    removed.push(target);
    if (dryRun) {
      if (verbose) console.log(`[dry-run] would prune stale AIWG artifact: ${path.relative(process.cwd(), target)}`);
      continue;
    }
    try {
      fs.unlinkSync(target);
      if (Object.prototype.hasOwnProperty.call(managed, name)) {
        delete managed[name];
        sidecarDirty = true;
      }
      if (verbose) console.log(`pruned stale AIWG artifact: ${path.relative(process.cwd(), target)}`);
    } catch (err) {
      removed.pop();
      if (verbose) console.warn(`Warning: could not prune ${target}: ${err.message}`);
    }
  }

  if (sidecarDirty) writeSidecarManifest(destDir, sidecar, dryRun);
  return removed;
}
