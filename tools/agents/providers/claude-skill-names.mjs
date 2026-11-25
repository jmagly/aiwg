// Guard Claude's native namespace and retire managed PR Steward instruction folders.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { contentHash, readSidecarManifest, writeSidecarManifest } from './base-files.mjs';
import { parseFrontmatter } from './base-frontmatter.mjs';
import { skillMatchesProvider } from './base-models-platforms.mjs';
import { isPrStewardGuidance } from './claude-pr-steward.mjs';

const inventory = JSON.parse(fs.readFileSync(new URL('./claude-builtins.json', import.meta.url), 'utf8'));
export const CLAUDE_BUILTINS = new Set([...inventory.bundledSkills, ...inventory.unshadowableCommands, ...inventory.reservedFolders]);
export const CLAUDE_UNSHADOWABLE_COMMANDS = new Set(inventory.unshadowableCommands);
export const CLAUDE_UNVERIFIED_LOCAL_COMMANDS = new Set(inventory.unverifiedLocalCommands);
export const CLAUDE_RESERVED_FOLDERS = new Set(inventory.reservedFolders);
const SKILL_DEPLOY_NAMES = new Map(Object.entries(inventory.skillDeployNames));
const STEWARD = 'aiwg-steward-routing';
function metadata(content) {
  return yaml.load(parseFrontmatter(content).frontmatter || '') || {};
}
function assertAvailable(name, source) {
  if (CLAUDE_BUILTINS.has(String(name).toLowerCase())) {
    throw new Error(`Claude Code built-in /${name} collides with ${source}; rename it or declare a non-reserved skill alias before deployment.`);
  }
}
export function validateClaudeCommands(files) {
  for (const file of files) {
    assertAvailable(path.basename(file, path.extname(file)), file);
    assertAvailable(metadata(fs.readFileSync(file, 'utf8')).name, file);
  }
}
export function resolveClaudeSkillName(dir) {
  const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const slug = path.basename(dir);
  if (!skillMatchesProvider(content, 'claude')) return slug;
  const data = metadata(content);
  if (!CLAUDE_BUILTINS.has(slug.toLowerCase()) && !CLAUDE_BUILTINS.has(String(data.name).toLowerCase())) return slug;
  const alias = [data.name, ...(Array.isArray(data.aliases) ? data.aliases : [])].find(name =>
    typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name) && !CLAUDE_BUILTINS.has(name));
  if (alias) return alias;
  const mapped = SKILL_DEPLOY_NAMES.get(slug.toLowerCase());
  if (mapped) { assertAvailable(mapped, dir); return mapped; }
  assertAvailable(slug, dir);
  assertAvailable(data.name, dir);
  return slug;
}
export function claudeKernelNames(names) {
  // Keep the source slug too: namespace-only, unmarked operator copies are not migrations.
  if (names == null) return names;
  const aliases = [...names].flatMap(name => SKILL_DEPLOY_NAMES.get(name) || []);
  return [...new Set([...names, ...aliases, STEWARD, ...CLAUDE_RESERVED_FOLDERS])];
}
export function prepareClaudeSkills(dirs, standard, kernel, opts, transform) {
  // Validate the entire batch before any writes, including index-only skills.
  const names = new Map(dirs.map(dir => [dir, resolveClaudeSkillName(dir)]));
  const renamed = new Set([...names].filter(([dir, name]) => name !== path.basename(dir)).map(([, name]) => name));
  migrateClaudeReservedSkills(kernel, opts);
  migrateClaudeReservedSkills(standard, opts);
  return { ...opts, resolveSkillName: dir => names.get(dir), transformSkillMd: (content, options) => {
    const name = options.skillName;
    const rendered = name && (renamed.has(name) || CLAUDE_BUILTINS.has(String(metadata(content).name).toLowerCase()))
      ? content.replace(/^(---\r?\n[\s\S]*?\n?)name:[^\r\n]*/u, `$1name: ${name}`) : content;
    return transform(rendered);
  } };
}

export function migrateClaudeSteward(skills, opts = {}) {
  const old = path.join(skills, 'steward');
  if (!isManagedFolder(old)) return false;
  const next = path.join(skills, STEWARD);
  if (fs.existsSync(next) && (!fs.lstatSync(next).isDirectory() || !fs.existsSync(path.join(next, '.aiwg-managed')))) {
    throw new Error(`Unmanaged ${next}: cannot migrate steward; move the replacement aside and refresh again.`);
  }
  const backup = path.join(next, '.aiwg-backup-steward');
  if (fs.existsSync(backup)) throw new Error(`${backup} already exists; preserve it elsewhere before migrating another steward copy.`);
  if (opts.dryRun) {
    console.log(`[dry-run] Would migrate ${old} to ${next} (original retained in .aiwg-backup-steward)`);
    return true;
  }
  opts.replacedSkillCopies ||= new Set();
  // Copy only absent entries; conflicting bytes remain intact in the full backup.
  const merge = (from, to) => {
    if (!fs.existsSync(to)) { fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true }); return; }
    if (fs.lstatSync(from).isDirectory() && fs.lstatSync(to).isDirectory()) {
      for (const entry of fs.readdirSync(from)) merge(path.join(from, entry), path.join(to, entry));
    }
  };
  merge(old, next);
  const receipt = readSidecarManifest(next);
  let receiptChanged = false;
  const skill = path.join(next, 'SKILL.md');
  if (fs.existsSync(skill)) {
    const previous = fs.readFileSync(skill, 'utf8');
    const updated = previous.replace(/^(---\r?\n[\s\S]*?\n?)name:[^\r\n]*/u, `$1name: ${STEWARD}`);
    if (updated !== previous) {
      fs.writeFileSync(skill, updated);
      // Preserve the edited/unmodified distinction used by the regular copier.
      if (receipt?.managed?.['SKILL.md']?.hash === `sha256:${contentHash(previous)}`) {
        receipt.managed['SKILL.md'].hash = `sha256:${contentHash(updated)}`;
        receiptChanged = true;
      }
    }
  }
  // Migrated resources are preserved local data, not files the new source may prune.
  for (const relative of Object.keys(receipt?.managed || {})) {
    if (relative === 'SKILL.md') continue;
    const from = path.resolve(old, relative), to = path.resolve(next, relative);
    if (!from.startsWith(`${path.resolve(old)}${path.sep}`) || !to.startsWith(`${path.resolve(next)}${path.sep}`)) continue;
    if (fs.existsSync(from) && fs.existsSync(to) && fs.lstatSync(from).isFile() && fs.lstatSync(to).isFile()
      && fs.readFileSync(from).equals(fs.readFileSync(to))) {
      delete receipt.managed[relative];
      receiptChanged = true;
    }
  }
  if (receiptChanged) writeSidecarManifest(next, receipt, false);
  const preserveMoved = file => {
    opts.replacedSkillCopies?.add(path.resolve(file));
    opts.replacedSkillCopies?.add(path.resolve(opts.logicalOutputPath?.(file) || file));
  };
  const replaced = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) replaced(file);
      else {
        preserveMoved(file);
        const relative = path.relative(old, file);
        if (!['SKILL.md', '.aiwg-manifest.json', '.aiwg-managed'].includes(relative)) preserveMoved(path.join(next, relative));
      }
    }
  };
  replaced(old);
  fs.renameSync(old, backup);
  // Backups sit beneath a native skill: do not leave another loadable SKILL.md.
  const hideSkills = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) hideSkills(file);
      else if (entry.name === 'SKILL.md') {
        let archived = `${file}.original`;
        while (fs.existsSync(archived)) archived += '.original';
        fs.renameSync(file, archived);
        preserveMoved(archived);
      } else {
        preserveMoved(file);
      }
    }
  };
  hideSkills(backup);
  if (!opts.quiet) console.log(`Migrated Claude skill steward -> ${STEWARD}; original retained in ${backup}`);
  return true;
}

function isManagedFolder(dir) {
  try {
    return fs.lstatSync(dir).isDirectory() && fs.lstatSync(path.join(dir, '.aiwg-managed')).isFile();
  } catch { return false; }
}

export function migrateClaudeReservedSkills(skills, opts = {}) {
  if (!skills) return;
  for (const name of CLAUDE_RESERVED_FOLDERS) {
    const old = path.join(skills, name);
    if (!fs.existsSync(old)) continue;
    if (name === 'steward' && isPrStewardGuidance(old)) continue;
    if (!isManagedFolder(old)) {
      opts.claudeReservedNotices ||= new Set();
      if (!opts.claudeReservedNotices.has(old)) {
        console.warn(`Notice: Claude Code's built-in /steward (PR Steward) reads ${opts.logicalOutputPath?.(path.join(old, 'SKILL.md')) || path.join(old, 'SKILL.md')}; unmanaged guidance left untouched.`);
        opts.claudeReservedNotices.add(old);
      }
      continue;
    }
    if (name === 'steward') {
      try { migrateClaudeSteward(skills, opts); }
      catch (error) {
        // A blocked rename must not leave managed PR instructions at a reserved path.
        if (isManagedFolder(old)) archiveReservedFolder(old, skills, name, opts);
        throw error;
      }
      continue;
    }
    // No AIWG babysit skill exists: archive the legacy folder outside native skills.
    archiveReservedFolder(old, skills, name, opts);
  }
}

function archiveReservedFolder(old, skills, name, opts) {
  const archives = path.join(path.dirname(skills), '.aiwg-reserved-skill-backups');
  let backup = path.join(archives, name);
  for (let index = 1; fs.existsSync(backup); index++) backup = path.join(archives, `${name}-${index}`);
  if (opts.dryRun) {
    console.log(`[dry-run] Would archive reserved Claude folder ${old} to ${backup}`);
    return;
  }
  opts.replacedSkillCopies ||= new Set();
  const preserve = file => {
    opts.replacedSkillCopies.add(path.resolve(file));
    opts.replacedSkillCopies.add(path.resolve(opts.logicalOutputPath?.(file) || file));
  };
  const walk = (dir, visit) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, visit);
      else visit(file);
    }
  };
  walk(old, preserve);
  fs.mkdirSync(archives, { recursive: true });
  fs.renameSync(old, backup);
  walk(backup, file => {
    if (path.basename(file) === 'SKILL.md') {
      let archived = `${file}.original`;
      while (fs.existsSync(archived)) archived += '.original';
      fs.renameSync(file, archived);
      preserve(archived);
    } else preserve(file);
  });
  if (!opts.quiet) console.log(`Archived reserved Claude folder ${old} to ${backup}`);
}
