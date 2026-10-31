// Delete legacy skill copies only when recorded payloads still match their digests.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export function removeSkillCopy(dir, opts = {}) {
  if (opts.copyMode ?? opts.copyStandardSkills) return false;
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(path.join(dir, '.aiwg-manifest.json'), 'utf8')); }
  catch { /* Markers alone cannot prove the copy is unchanged. */ }
  if (!receipt?.managed?.['SKILL.md']?.hash) {
    console.warn(`${opts.logicalOutputPath?.(dir) || dir}: kept (unverifiable ownership)`); return false;
  }
  if (receipt?.managed) {
    const walk = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(root, entry.name);
      return entry.isDirectory() ? walk(file) : [file];
    });
    const safe = walk(dir).every(file => {
      const name = path.relative(dir, file);
      if (['.aiwg-manifest.json', '.aiwg-managed'].includes(name)) return true;
      return fs.lstatSync(file).isFile() && receipt.managed[name]?.hash === `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    });
    if (!safe) { console.warn(`${opts.logicalOutputPath?.(dir) || dir}: kept (operator-edited or unrecorded files)`); return false; }
  }
  if (!opts.dryRun) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
