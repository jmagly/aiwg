// Generate static skill imports from selected bundles and actual deployed files.
import fs from 'node:fs';
import path from 'node:path';
import { listSkillDirs } from './base-files.mjs';
import { camel, selectedFlueBundles } from './flue-bundles.mjs';

export function generateFlueSkills(target, opts) {
  const bundles = selectedFlueBundles(opts).map(bundle => ({ ...bundle,
    skills: listSkillDirs(path.join(bundle.root, bundle.manifest.entry?.skills || 'skills'))
      .map(dir => path.basename(dir)).filter(name => fs.existsSync(path.join(target, '.agents/skills', name, 'SKILL.md'))).sort(),
  }));
  const names = [...new Set(bundles.flatMap(bundle => bundle.skills))].sort();
  const exports = new Map();
  for (const name of names) {
    const identifier = camel(name);
    if (!/^[a-zA-Z_$][\w$]*$/.test(identifier) || exports.has(identifier)) throw new Error(`Ambiguous Flue skill export: ${name}`);
    exports.set(identifier, name);
  }
  return `// AIWG bundle skills; static imports are required by Flue.\nimport { useSkill } from '@flue/runtime';\n${names.map(name => `import ${camel(name)} from '../../.agents/skills/${name}/SKILL.md';`).join('\n')}\n\n${names.length ? `export { ${names.map(camel).join(', ')} };\n\n` : ''}${bundles.map(bundle => `export const ${camel(bundle.id === 'sdlc-complete' ? 'sdlc' : bundle.id)}Skills = [${bundle.skills.map(camel).join(', ')}] as const;`).join('\n')}\n\nexport function useAiwgSkills(...bundles: ReadonlyArray<readonly Parameters<typeof useSkill>[0][]>) {\n  for (const skill of new Set(bundles.flat())) useSkill(skill);\n}\n`;
}
