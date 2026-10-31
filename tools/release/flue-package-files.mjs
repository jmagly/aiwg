// Select canonical published bundle skills; extensions remain workspace-only.
import fs from 'node:fs';
import path from 'node:path';
import { flueBundleInventory } from '../agents/providers/flue-bundles.mjs';
import { listSkillDirs } from '../agents/providers/base-files.mjs';
import { skillMatchesProvider } from '../agents/providers/base-models-platforms.mjs';
import { validateFlueSkill } from '../agents/providers/flue-validation.mjs';
export function fluePackageSkills(root) {
  const bundles = flueBundleInventory({ srcRoot: root }).filter(bundle => ['frameworks', 'addons'].includes(path.basename(path.dirname(bundle.root))));
  const skills = new Map();
  for (const bundle of bundles) {
    for (const directory of listSkillDirs(path.join(bundle.root, bundle.manifest.entry?.skills || 'skills'))) {
      const file = path.join(directory, 'SKILL.md');
      const content = fs.readFileSync(file, 'utf8');
      if (!skillMatchesProvider(content, 'flue')) continue;
      try { validateFlueSkill(content, file); }
      catch (error) {
        if (path.basename(path.dirname(bundle.root)) === 'frameworks') throw error;
        continue; // D10 includes only addon skills that pass the validator.
      }
      const name = path.basename(directory);
      // A shared subpath uses the first canonical framework in inventory order.
      if (!skills.has(name)) skills.set(name, directory);
    }
  }
  return { bundles, skills };
}
