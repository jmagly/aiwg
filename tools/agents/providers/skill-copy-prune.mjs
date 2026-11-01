// Retire skill copies using recorded hashes, with legacy marker support in index mode.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export function removeSkillCopy(dir, opts = {}) {
  const copyMode = opts.copyMode ?? opts.copyStandardSkills;
  if (copyMode && !opts.tierMove) return false;
  // A copy-mode tier move only replaces: the new-tier copy must already exist.
  if (copyMode && opts.tierMove && !(opts.replacement && fs.existsSync(path.join(opts.replacement, 'SKILL.md')))) {
    console.warn(`${opts.logicalOutputPath?.(dir) || dir}: kept (replacement copy missing)`);
    return false;
  }
  const keep = reason => {
    console.warn(`${opts.logicalOutputPath?.(dir) || dir}: kept (${reason})`);
    return false;
  };
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(path.join(dir, '.aiwg-manifest.json'), 'utf8')); }
  catch (error) {
    // Only a missing receipt may use legacy ownership. An invalid receipt must
    // not turn an edited copy into a marker-only deletion candidate.
    if (error.code !== 'ENOENT') return keep('unverifiable ownership');
    if (copyMode || !fs.existsSync(path.join(dir, '.aiwg-managed'))) return keep('unverifiable ownership');
    if (!opts.dryRun) fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  if (!receipt?.managed?.['SKILL.md']?.hash) return keep('unverifiable ownership');
  const walk = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
  const payload = walk(dir).filter(file => {
    const name = path.relative(dir, file);
    return name !== '.aiwg-manifest.json' && (name !== '.aiwg-managed' || receipt.managed[name]);
  });
  const safe = payload.length === Object.keys(receipt.managed).length && payload.every(file => {
    const name = path.relative(dir, file);
    return fs.lstatSync(file).isFile() && receipt.managed[name]?.hash === `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
  });
  if (!safe) return keep('operator-edited or unrecorded files');
  if (!opts.dryRun) {
    if (opts.tierMove) for (const file of walk(dir)) {
      opts.replacedSkillCopies?.add(path.resolve(file));
      opts.replacedSkillCopies?.add(path.resolve(opts.logicalOutputPath?.(file) || file));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}
