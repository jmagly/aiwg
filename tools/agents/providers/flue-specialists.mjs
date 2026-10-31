// Generate the selected Flue delegates from canonical agents and shared rule transforms.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { camel, flueBundleInventory, selectedFlueBundles } from './flue-bundles.mjs';
import { generateFlueSkills } from './flue-skills.mjs';
import { parseFrontmatter } from './base-frontmatter.mjs';
import { injectBoundRules } from './base-contract.mjs';
import { claimRecordedFile } from './flue-project.mjs';

function specialists(bundles) {
  return [...new Map(bundles.flatMap(bundle => (bundle.manifest.flue?.specialists || []).map(name =>
    [name, { name, exportName: camel(name), file: `${name}.md`, root: bundle.root }]))).values()];
}
export const FLUE_SPECIALISTS = Object.freeze(specialists(flueBundleInventory({ srcRoot: fileURLToPath(new URL('../../../', import.meta.url)) }))
  .map(({ root: _root, ...entry }) => Object.freeze(entry)));

export function generateFlueSpecialists(opts) {
  const selected = specialists(selectedFlueBundles(opts));
  const definitions = selected.map(specialist => {
    const logical = path.join(specialist.root, 'agents', specialist.file);
    const file = opts.mapInputPath?.(logical) || logical;
    const { body, metadata } = parseFrontmatter(injectBoundRules(fs.readFileSync(file, 'utf8'), file, opts));
    return `export const ${specialist.exportName} = defineSubagent({
  name: ${JSON.stringify(specialist.name)},
  description: ${JSON.stringify(metadata.description || metadata.name)},
  agent() {
    useTool(aiwg_discover);
    useTool(aiwg_show);
    useTool(aiwg_artifact_write);
    return ${JSON.stringify(body.trim())};
  },
});`;
  });
  return `// Curated AIWG delegates; regenerate from canonical sdlc-complete agents.
import { defineSubagent, useSubagent, useTool } from '@flue/runtime';
import { aiwg_discover, aiwg_show, aiwg_artifact_write } from './tools.ts';

${definitions.join('\n\n')}

/** Trusted app options: omit pins to inherit the app model and effort. */
export function useAiwgSpecialists(pins: { ${selected.map(({ exportName }) => `${exportName}?: string`).join('; ')} } = {}) {
${selected.map(({ exportName }) => `  useSubagent(pins.${exportName} === undefined ? ${exportName} : { ...${exportName}, model: pins.${exportName} });`).join('\n')}
}
`;
}

export function deployFlueSpecialists(target, opts) {
  // Preserve operator files even on --force. Unchanged managed outputs can refresh.
  const write = (relative, content) => {
    const file = path.join(target, relative);
    if (fs.lstatSync(file, { throwIfNoEntry: false })) {
      if (!claimRecordedFile(target, file, opts)) {
        console.warn(`Flue (experimental): keeping existing module ${opts.logicalOutputPath?.(file) || file}`);
        return;
      }
    }
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content());
    }
  };
  const template = fileURLToPath(new URL('../../../agentic/code/providers/flue/templates/aiwg/tools.ts', import.meta.url));
  write('src/aiwg/tools.ts', () => fs.readFileSync(opts.mapInputPath?.(template) || template, 'utf8'));
  write('src/aiwg/specialists.ts', () => generateFlueSpecialists(opts));
  write('src/aiwg/skills.ts', () => generateFlueSkills(target, opts));
}
