// Retire legacy AIWG output transactionally, retaining original bytes for recovery.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { MANAGED_MARKER_RE } from './base-files.mjs';

const MANIFEST = '.aiwg-manifest.json';
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const inside = (root, file) => file.startsWith(`${root}${path.sep}`);

export function migrateLegacyWindsurfContent(target, opts = {}) {
  const root = path.join(target, '.windsurf');
  if (!fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) return;
  const files = [];
  const directories = [];
  const visit = dir => {
    directories.push(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push(file); // Never follow operator symlinks.
    }
  };
  visit(root);
  const claims = new Set();
  const manifests = files.filter(file => path.basename(file) === MANIFEST);
  for (const file of [...manifests, path.join(target, '.aiwg', MANIFEST)]) {
    const receipt = readJson(file);
    const base = receipt.scope === 'project' ? target : path.dirname(file);
    for (const name of Object.keys(receipt.managed || {})) {
      const claimed = path.resolve(base, name);
      if (inside(root, claimed)) claims.add(claimed);
    }
  }
  const owned = files.filter(file => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return claims.has(file);
    if (!stat.isFile()) return false;
    if (claims.has(file) || path.basename(file) === '.aiwg-managed') return true;
    if (path.basename(file) === MANIFEST) return Boolean(readJson(file).managed);
    if (/\.(md|mdc)$/.test(file) && MANAGED_MARKER_RE.test(fs.readFileSync(file, 'utf8'))) return true;
    return path.basename(file) === 'SKILL.md' && fs.existsSync(path.join(path.dirname(file), '.aiwg-managed'));
  });
  const archive = path.join(target, '.devin', '.aiwg', 'legacy-windsurf');
  if (owned.length && !opts.dryRun) {
    // A single recovery file avoids copying thousands of archived artifacts on
    // every later addon transaction. Keep bytes and permissions, including edits.
    const archiveFile = path.join(archive, 'originals.json.gz');
    const saved = Object.assign(Object.create(null), fs.existsSync(archiveFile)
      ? JSON.parse(gunzipSync(fs.readFileSync(archiveFile)).toString('utf8')) : {});
    for (const file of owned) {
      const stat = fs.lstatSync(file);
      const entry = { mode: stat.mode & 0o777, ...(stat.isSymbolicLink()
        ? { link: fs.readlinkSync(file) } : { bytes: fs.readFileSync(file).toString('base64') }) };
      let key = path.relative(root, file);
      if (saved[key] && (saved[key].bytes !== entry.bytes || saved[key].link !== entry.link || saved[key].mode !== entry.mode)) {
        key += `.${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}`;
      }
      saved[key] = entry;
    }
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(archiveFile, gzipSync(JSON.stringify(saved)));
    for (const file of owned) {
      fs.unlinkSync(file);
      // Staging and outer preservation use different path identities.
      opts.replacedSkillCopies?.add(file);
      opts.replacedSkillCopies?.add(opts.logicalOutputPath?.(file) || file);
    }
  }
  if (!opts.dryRun) {
    for (const dir of directories.reverse()) {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
  }
  if (owned.length) console.log(`${opts.dryRun ? '[dry-run] Would migrate' : 'Migrated'} ${owned.length} AIWG-managed artifact(s) from .windsurf/ to .devin/; originals retained in .devin/.aiwg/legacy-windsurf/.`);
  const kept = files.length - owned.length;
  if (kept) console.warn(`Preserved ${kept} operator file(s) under .windsurf/ (not AIWG-managed).`);
}
