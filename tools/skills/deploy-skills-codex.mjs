#!/usr/bin/env node
/**
 * Deploy Skills to Codex
 *
 * Transforms AIWG skills to Codex format. The codex provider
 * (tools/agents/providers/codex.mjs) always invokes this with an explicit
 * `--target <project>/.agents/skills` — the cross-provider canonical path
 * codex-rs scans (codex-rs/core-skills/src/loader.rs).
 *
 * The `~/.codex/skills/` default below is the LEGACY home-dir path, deprecated
 * after the #766 regression fix: writing both .agents/skills and
 * ~/.codex/skills made codex list every kernel skill twice. It is retained
 * only as a standalone-invocation fallback; normal `aiwg use` deploys pass
 * --target and never write the legacy location.
 *
 * Codex Skill Format:
 * - Location: <target>/<skill-name>/SKILL.md
 * - YAML frontmatter: name (≤100 chars), description (≤500 chars)
 * - Body: Instructions (kept on disk, not injected into context)
 *
 * Usage:
 *   node tools/skills/deploy-skills-codex.mjs [options]
 *
 * Options:
 *   --source <path>    Source directory (defaults to repo root)
 *   --target <path>    Target directory (defaults to ~/.codex/skills — LEGACY;
 *                      orchestrator passes <project>/.agents/skills)
 *   --mode <type>      Deployment mode: addons, sdlc, marketing, media-curator, research, or all (default)
 *   --dry-run          Show what would be deployed without writing
 *   --force            Overwrite existing files
 */

import { removeSkillCopy } from '../agents/providers/skill-copy-prune.mjs';
import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';
import { fileURLToPath } from 'node:url';
import os from 'os';
import { deploySkillDir, getFrameworksForMode, normalizeDeploymentMode, isKernelSkill } from '../agents/providers/base.mjs';

import { writeCodexSkillMetadata } from './codex-skill-metadata.mjs';
import { stripWrappingQuotes, transformToCodexSkill } from './codex-skill-transform.mjs';
const LEGACY_RENAMED_SKILLS = new Set(['aiwg-mcp']);

/** Codex's built-in startup skill-listing cap, in characters (see doctor). */
export const CODEX_LISTING_CHAR_CAP = 8000;

export function resolveCodexListingCap(env = process.env) {
  const raw = env.AIWG_CODEX_LISTING_CAP;
  if (raw === undefined || raw === '') return CODEX_LISTING_CHAR_CAP;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : CODEX_LISTING_CHAR_CAP;
}

/** Chars one skill contributes to Codex's startup listing ("- name: desc\n"). */
export function listingEntryChars(name, description) {
  return String(name ?? '').length + String(description ?? '').length + 5;
}

function deployedSkillListing(skillDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'); } catch { return null; }
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!fm) return null;
  const name = stripWrappingQuotes(fm.match(/^\s*name:\s*(.+?)\s*$/m)?.[1] ?? '');
  const description = stripWrappingQuotes(fm.match(/^\s*description:\s*(.+?)\s*$/m)?.[1] ?? '');
  return name ? { name, description } : null;
}

/**
 * Decide which planned skills must leave the startup-visible kernel dir so
 * the projected listing stays under the cap (#2561). Existing kernel skills
 * that this run does not replace count toward the projection. Kernel-flagged
 * skills are never demoted; the rest are demoted largest-entry-first so the
 * fewest skills lose startup visibility. Returns the demoted set plus the
 * projected listing sizes for reporting.
 */
export function planCodexListingBudget(planned, kernelDir, cap) {
  const incomingNames = new Set(planned.map((item) => item.skill.name));
  let projected = 0;
  let existing = 0;
  if (fs.existsSync(kernelDir)) {
    for (const entry of fs.readdirSync(kernelDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const listing = deployedSkillListing(path.join(kernelDir, entry.name));
      if (!listing || incomingNames.has(listing.name) || incomingNames.has(entry.name)) continue;
      existing += listingEntryChars(listing.name, listing.description);
    }
  }
  projected = existing + planned.reduce((sum, item) => sum + listingEntryChars(item.skill.name, item.skill.description), 0);
  const before = projected;
  const demoted = new Set();
  if (!cap || projected <= cap) return { demoted, before, after: projected, cap };
  const demotable = planned
    .filter((item) => !item.kernel)
    .sort((a, b) => listingEntryChars(b.skill.name, b.skill.description) - listingEntryChars(a.skill.name, a.skill.description));
  for (const item of demotable) {
    if (projected <= cap) break;
    demoted.add(item);
    projected -= listingEntryChars(item.skill.name, item.skill.description);
  }
  return { demoted, before, after: projected, cap };
}

function parseArgs(args, homeDir) {
  const cfg = {
    source: null,
    target: path.join(homeDir, '.codex', 'skills'),
    mode: 'all',
    dryRun: false,
    force: false,
    copyStandardSkills: false,
    // Codex lists every skill under the kernel dir at startup and truncates the
    // listing at 8,000 chars. Skills that would push the listing past the cap
    // are placed on the standard tier instead (#2561). The budget is active
    // only when the caller names a standard tier (`--standard-target`, set by
    // the codex provider for project deploys) or passes `--listing-cap`
    // explicitly; standalone/legacy home-dir invocations keep deploying every
    // selected skill to the target. 0 disables the budget.
    listingCap: resolveCodexListingCap(),
    listingCapExplicit: false,
    listingBudget: false,
    standardTarget: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source' && args[i + 1]) cfg.source = path.resolve(args[++i]);
    else if (a === '--target' && args[i + 1]) cfg.target = path.resolve(args[++i]);
    else if (a === '--mode' && args[i + 1]) cfg.mode = String(args[++i]).toLowerCase();
    else if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--force') cfg.force = true;
    else if (a === '--index-mode') cfg.indexMode = true;
    else if (a === '--copy-all' || a === '--copy-standard-skills') cfg.copyStandardSkills = true;
    else if (a === '--listing-cap' && args[i + 1]) { cfg.listingCap = Math.max(0, Number(args[++i]) || 0); cfg.listingCapExplicit = true; }
    else if (a === '--standard-target' && args[i + 1]) cfg.standardTarget = path.resolve(args[++i]);
    else if (a === '--listing-budget') cfg.listingBudget = true;
  }

  cfg.mode = normalizeDeploymentMode(cfg.mode);
  return cfg;
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/**
 * Find skill directories containing SKILL.md
 */
function findSkillDirs(baseDir) {
  if (!fs.existsSync(baseDir)) return [];

  const skillDirs = [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillPath = path.join(baseDir, entry.name, 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        skillDirs.push(path.join(baseDir, entry.name));
      }
    }
  }

  return skillDirs;
}

/**
 * Deploy skill to Codex skills directory
 */
function deploySkill(skill, targetDir, opts) {
  const { force = false, dryRun = false } = opts;
  const skillDir = path.join(targetDir, skill.name);

  if (dryRun) {
    console.log(`  [dry-run] deploy: ${skill.name}`);
    if (skill.modelPolicy) {
      console.log(
        `    model policy: unsupported (${skill.modelPolicy.role}/${skill.modelPolicy.tier}); no native field emitted`
      );
    }
    return { action: 'deploy', reason: 'dry-run' };
  }

  // Use the same whole-folder copier and ownership receipt as other providers.
  const deployed = deploySkillDir(path.dirname(skill.sourcePath), targetDir, {
    ...opts, force, dryRun, provider: 'codex', skillName: skill.name,
    transformSkillMd: () => skill.content,
  });
  if (deployed === false) return { action: 'skip', reason: 'ownership' };
  writeCodexSkillMetadata(skillDir, skill.metadataContent);
  console.log(`  deployed: ${skill.name}`);

  return { action: 'deploy', reason: 'success' };
}

/**
 * Get skill directories based on mode
 */
function getSkillDirectories(srcRoot, mode) {
  const dirs = [];

  const directSkillsDir = path.join(srcRoot, 'skills');
  if (fs.existsSync(directSkillsDir)) {
    dirs.push({ dir: directSkillsDir, label: path.basename(srcRoot) });
  }

  // Addon skills
  if (mode === 'addons' || mode === 'all') {
    const addonsRoot = path.join(srcRoot, 'agentic', 'code', 'addons');
    if (fs.existsSync(addonsRoot)) {
      const addonDirs = fs.readdirSync(addonsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(addonsRoot, e.name, 'skills'));

      for (const addonSkillsDir of addonDirs) {
        if (fs.existsSync(addonSkillsDir)) {
          dirs.push({ dir: addonSkillsDir, label: path.basename(path.dirname(addonSkillsDir)) });
        }
      }
    }
  }

  // Framework skills discovered from framework manifests/directory structure.
  const frameworks = getFrameworksForMode(srcRoot, mode);
  for (const framework of frameworks) {
    if (framework.components.skills.exists) {
      dirs.push({ dir: framework.components.skills.path, label: framework.id });
    }
  }

  return dirs;
}

function isFullAiwgSourceRoot(srcRoot) {
  return fs.existsSync(path.join(srcRoot, 'agentic', 'code', 'frameworks')) ||
    fs.existsSync(path.join(srcRoot, 'agentic', 'code', 'addons')) ||
    fs.existsSync(path.join(srcRoot, 'agentic', 'code', 'extensions'));
}

export async function main(args = process.argv.slice(2), internal = {}) {
  const cfg = parseArgs(args, internal.homeDir || os.homedir());
  const { source, target, mode, dryRun, force } = cfg;

  // Resolve source directory
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(scriptDir, '..', '..');
  const srcRoot = source || repoRoot;
  const fullAiwgSourceRoot = isFullAiwgSourceRoot(srcRoot);
  const copyStandardSkills = cfg.copyStandardSkills === true;
  // Component-scoped deploys (the way `aiwg use all` installs selected
  // frameworks/addons) still need a complete inventory for stale-skill
  // reconciliation.  AIWG_ROOT is supplied by the orchestrator for exactly
  // this purpose; fall back to the script checkout for standalone use.
  const configuredAiwgRoot = process.env.AIWG_ROOT
    ? path.resolve(process.env.AIWG_ROOT)
    : repoRoot;
  const inventoryRoot = fullAiwgSourceRoot
    ? srcRoot
    : (!copyStandardSkills && isFullAiwgSourceRoot(configuredAiwgRoot) ? configuredAiwgRoot : null);

  console.log(`Deploying skills to Codex`);
  console.log(`  Source: ${srcRoot}`);
  console.log(`  Target: ${target}`);
  console.log(`  Mode: ${mode}`);
  if (dryRun) console.log(`  [DRY RUN]`);
  console.log();

  // Create target directory
  if (!dryRun) {
    ensureDir(target);
  }

  // Get skill directories based on mode
  const skillDirs = getSkillDirectories(srcRoot, mode);
  let totalDeployed = 0;
  let totalSkipped = 0;

  // Honor #1217 kernel-pivot default: deploy only kernel skills unless
  // the operator opts in via `--copy-all` (or `--copy-standard-skills`).
  // Codex normally deploys to the project `.agents/skills/` target, so the
  // kernel/standard split is enforced at filter time rather than via separate
  // destination directories. The standalone legacy default remains supported.
  // Track every AIWG-managed source skill name so we can scope post-deploy
  // cleanup to skills AIWG ships — never delete user-authored or
  // third-party skills sitting alongside.
  //
  // Two name spaces matter for cleanup: source basename (`addons/foo/skills/<name>/`)
  // AND deployed name (the `name:` frontmatter field, which Codex uses as
  // the target directory). Sample: source `archive-acquisition` deploys
  // as `Archive Acquisition`. Track both so cleanup catches each form.
  const allManagedNames = new Set();
  const desiredNames = new Set();

  // Pre-pass: walk every framework/addon skill directory in the source tree
  // so full-root cleanup can remove stale AIWG skills. Component-scoped
  // cleanup is limited below to names owned by that component, preserving
  // user-authored skills alongside the generated set.
  for (const { dir } of getSkillDirectories(inventoryRoot || srcRoot, 'all')) {
    const allSkills = findSkillDirs(dir);
    for (const s of allSkills) {
      allManagedNames.add(path.basename(s));
      if (!copyStandardSkills && isKernelSkill(s)) {
        desiredNames.add(path.basename(s));
      }
      // Also record the frontmatter `name:` since Codex uses that as the
      // target dir. Best-effort — ignore parse errors.
      try {
        const content = fs.readFileSync(path.join(s, 'SKILL.md'), 'utf8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const nameMatch = fmMatch[1].match(/^\s*name:\s*(.+?)\s*$/m);
          if (nameMatch) {
            const deployedName = stripWrappingQuotes(nameMatch[1]);
            allManagedNames.add(deployedName);
            if (!copyStandardSkills && isKernelSkill(s)) {
              desiredNames.add(deployedName);
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Plan every skill first so the listing budget can be judged across the
  // whole run rather than per source directory (#2561).
  const planned = [];
  for (const { dir, label } of skillDirs) {
    const found = findSkillDirs(dir);
    if (found.length === 0) continue;

    for (const s of found) allManagedNames.add(path.basename(s));

    const skills = copyStandardSkills
      ? found
      : found.filter(s => isKernelSkill(s));
    if (skills.length === 0) continue;

    for (const skillDir of skills) {
      const skill = transformToCodexSkill(skillDir);
      if (!skill) {
        // transformToCodexSkill already logged the specific reason (parse
        // error, missing description, platform mismatch, etc.).
        console.log(`  skip: ${path.basename(skillDir)} (see error above)`);
        totalSkipped++;
        continue;
      }
      planned.push({ skill, skillDir, label, kernel: isKernelSkill(skillDir) });
    }
  }

  const standardTarget = cfg.standardTarget
    || path.join(path.dirname(path.dirname(target)), '.codex', '.aiwg', 'skills');
  // An operator `--copy-all` asks for every standard skill in the listing;
  // honoring the cap there would silently undo the request and break the
  // documented kernel/standard contract. `--listing-budget` is how the caller
  // says the copy-all was its own doing (project-local bundles force it so
  // their skills are reachable at all) and the cap still applies (#2561).
  const budgetActive = cfg.listingCapExplicit
    || cfg.listingBudget
    || (Boolean(cfg.standardTarget) && !copyStandardSkills);
  const budget = planCodexListingBudget(planned, target, budgetActive ? cfg.listingCap : 0);
  for (const item of planned) {
    if (budget.demoted.has(item)) continue;
    desiredNames.add(path.basename(item.skillDir));
    desiredNames.add(item.skill.name);
  }

  let currentLabel = null;
  for (const item of planned) {
    if (item.label !== currentLabel) {
      currentLabel = item.label;
      console.log(`\n${item.label} (${planned.filter((p) => p.label === item.label).length} skills):`);
    }
    const demoted = budget.demoted.has(item);
    const result = deploySkill(item.skill, demoted ? standardTarget : target, { force, dryRun, copyStandardSkills, copyMode: copyStandardSkills && !cfg.indexMode });
    if (demoted) console.log(`    ↳ standard tier (${path.relative(process.cwd(), standardTarget) || standardTarget}) — startup listing budget`);
    if (result.action === 'deploy') totalDeployed++;
    else totalSkipped++;
  }

  if (budget.demoted.size > 0) {
    const names = [...budget.demoted].map((item) => item.skill.name).join(', ');
    console.log(
      `\nCodex listing budget: ${budget.demoted.size} skill(s) placed on the standard tier so the startup listing ` +
      `stays at ~${budget.after.toLocaleString()} of ${budget.cap.toLocaleString()} chars (was ~${budget.before.toLocaleString()}): ${names}. ` +
      'They remain reachable through `aiwg discover` / `aiwg show`. Override with --listing-cap <chars> (0 disables) or AIWG_CODEX_LISTING_CAP.',
    );
  } else if (budgetActive && budget.cap && budget.after > budget.cap) {
    console.log(
      `\nWarning: kernel skills alone estimate ~${budget.after.toLocaleString()} chars, above Codex's ${budget.cap.toLocaleString()}-char listing cap; ` +
      'nothing non-kernel is left to demote.',
    );
  }

  // Post-deploy cleanup: remove AIWG-managed skills that are stale for the
  // current source scope.
  //
  // Full AIWG-root deploys may prune any `.aiwg-managed` skill because they
  // computed a complete desired set. Component-scoped deploys (`aiwg use all`
  // later iterates each addon/extension after the full-root pass) must only
  // prune names owned by that component. Otherwise an addon with no kernel
  // skills can delete the kernel skills installed by the preceding full-root
  // Codex pass, leaving `.agents/skills/` empty while `aiwg use` still exits 0.
  let totalPruned = 0;
  if ((!copyStandardSkills || cfg.indexMode) && fs.existsSync(target)) {
    const targetEntries = fs.readdirSync(target, { withFileTypes: true });
    for (const entry of targetEntries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (desiredNames.has(name)) continue;

      // Known renamed AIWG skills may predate both the current source name and
      // the .aiwg-managed marker. Treat only the exact historical names as
      // managed so malformed legacy frontmatter cannot survive an upgrade.
      let isAiwgManaged = allManagedNames.has(name) || LEGACY_RENAMED_SKILLS.has(name);
      if (!isAiwgManaged && (fullAiwgSourceRoot || inventoryRoot)) {
        // Check for the .aiwg-managed marker file (preferred — survives
        // frontmatter transforms) or fall back to namespace check.
        const markerFile = path.join(target, name, '.aiwg-managed');
        if (fs.existsSync(markerFile)) {
          isAiwgManaged = true;
        } else {
          const skillFile = path.join(target, name, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            try {
              const content = fs.readFileSync(skillFile, 'utf8');
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              if (fmMatch) {
                const fm = fmMatch[1];
                if (/^\s*namespace:\s*["']?aiwg["']?\s*$/m.test(fm)) {
                  isAiwgManaged = true;
                }
              }
            } catch { /* ignore unreadable; leave alone */ }
          }
        }
      }
      if (!isAiwgManaged) continue;

      const full = path.join(target, name);
      if (dryRun) {
        console.log(`  [dry-run] would prune stale skill: ${name}`);
      } else {
        if (!removeSkillCopy(full, { ...cfg, copyMode: copyStandardSkills && !cfg.indexMode })) continue;
      }
      totalPruned++;
    }
  }

  const prunedNote = totalPruned > 0 ? `, ${totalPruned} pruned` : '';
  console.log(`\nSummary: ${totalDeployed} deployed, ${totalSkipped} skipped${prunedNote}`);

  if (!dryRun && totalDeployed > 0) {
    console.log(`\nRestart Codex to load new skills.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
