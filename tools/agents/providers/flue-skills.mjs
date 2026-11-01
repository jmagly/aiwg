// Generate static skill imports from selected bundles and actual deployed files.
import fs from 'node:fs';
import path from 'node:path';
import { getFrameworksForMode } from './base-framework-discovery.mjs';
import { listSkillDirs } from './base-files.mjs';
import { skillMatchesProvider } from './base-models-platforms.mjs';
import { validateFlueSkill } from './flue-validation.mjs';
import { importImpl } from '../../_resolve-impl.mjs';
const { frameworkRegistryId } = await importImpl(import.meta.url, 'config/framework-aliases.js');
import { camel, selectedFlueBundles } from './flue-bundles.mjs';

function publishedSkill(bundle, name) {
  if (!['frameworks', 'addons'].includes(path.basename(path.dirname(bundle.root)))) throw new Error(`${bundle.id}: @aiwg/flue publishes frameworks and addons only; use workspace copy mode`);
  const file = path.join(bundle.root, bundle.manifest.entry?.skills || 'skills', name, 'SKILL.md');
  const content = fs.readFileSync(file, 'utf8');
  if (!skillMatchesProvider(content, 'flue')) return false;
  try { validateFlueSkill(content, file); return true; } catch (error) {
    if (path.basename(path.dirname(bundle.root)) === 'frameworks') throw error;
    return false;
  }
}
export function generateFlueSkills(target, opts) {
  const selected = selectedFlueBundles(opts);
  const exact = selected.find(bundle => path.resolve(bundle.root) === path.resolve(opts.srcRoot));
  const invoked = new Set(exact ? [exact.id] : getFrameworksForMode(opts.srcRoot, opts.mode || 'sdlc').map(bundle => bundle.id));
  const all = opts.mode === 'all' && !exact;
  const bundles = selected.filter(bundle => !(all && opts.fluePackage) || ['frameworks', 'addons'].includes(path.basename(path.dirname(bundle.root)))).map(bundle => {
    const current = all || invoked.has(bundle.id);
    const declared = Object.entries(opts.config?.installed || {}).find(([id]) => frameworkRegistryId(id) === bundle.id);
    const packageMode = current ? opts.fluePackage : (declared ? declared[1].deployedTo?.flue?.package === true : opts.fluePackage);
    return { ...bundle, packageMode,
      skills: listSkillDirs(path.join(bundle.root, bundle.manifest.entry?.skills || 'skills'))
        .map(dir => path.basename(dir)).filter(name => packageMode ? publishedSkill(bundle, name) : fs.existsSync(path.join(target, '.agents/skills', name, 'SKILL.md'))).sort(),
    };
  });
  const packaged = new Set(bundles.filter(bundle => bundle.packageMode).flatMap(bundle => bundle.skills));
  const names = [...new Set(bundles.flatMap(bundle => bundle.skills))].sort();
  const exports = new Map();
  for (const name of names) {
    const identifier = camel(name);
    if (!/^[a-zA-Z_$][\w$]*$/.test(identifier) || exports.has(identifier)) throw new Error(`Ambiguous Flue skill export: ${name}`);
    exports.set(identifier, name);
  }
  return `// AIWG bundle skills; static imports are required by Flue.\nimport { useSkill } from '@flue/runtime';\n${names.map(name => `import ${camel(name)} from '${packaged.has(name) ? '@aiwg/flue/skills' : '../../.agents/skills'}/${name}/SKILL.md';`).join('\n')}\n\n${names.length ? `export { ${names.map(camel).join(', ')} };\n\n` : ''}${bundles.map(bundle => `export const ${camel(bundle.id === 'sdlc-complete' ? 'sdlc' : bundle.id)}Skills = [${bundle.skills.map(camel).join(', ')}] as const;`).join('\n')}\n\nexport function useAiwgSkills(...bundles: ReadonlyArray<readonly Parameters<typeof useSkill>[0][]>) {\n  for (const skill of new Set(bundles.flat())) useSkill(skill);\n}\n`;
}
