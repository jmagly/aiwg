// Preserve operator skill directories before using the shared bundle copier.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deploySkillDir } from './base-skill-copy.mjs';
export function deployFlueSkill(dir, destination, opts) {
  const target = path.join(destination, path.basename(dir));
  if (fs.existsSync(target)) {
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(path.join(target, '.aiwg-manifest.json'), 'utf8')); } catch { /* Unrecorded files are operator-owned. */ }
    const managed = receipt?.managed;
    const pristine = managed?.['SKILL.md'] && Object.entries(managed).every(([relative, record]) => {
      const file = path.resolve(target, relative);
      if (!file.startsWith(`${path.resolve(target)}${path.sep}`)) return false;
      try {
        return fs.lstatSync(file).isFile() && `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}` === record.hash;
      } catch { return false; }
    });
    if (!pristine) {
      console.warn(`Flue (experimental): keeping operator-edited or unrecorded skill ${opts.logicalOutputPath?.(target) || target}`);
      return false;
    }
  }
  return deploySkillDir(dir, destination, opts);
}
