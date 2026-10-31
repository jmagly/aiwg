// Generate the selected Flue delegates from canonical agents and shared rule transforms.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { camel, flueBundleInventory, selectedFlueBundles } from './flue-bundles.mjs';
import { generateFlueSkills } from './flue-skills.mjs';
import { parseFrontmatter } from './base-frontmatter.mjs';
import { injectBoundRules } from './base-contract.mjs';
import { claimRecordedFile } from './flue-project.mjs';
import { cloudflareTools } from './flue-cloudflare.mjs';

function specialists(bundles) {
  return [...new Map(bundles.flatMap(bundle => (bundle.manifest.flue?.specialists || []).map(name =>
    [name, { name, exportName: camel(name), file: `${name}.md`, root: bundle.root }]))).values()];
}
export const FLUE_SPECIALISTS = Object.freeze(specialists(flueBundleInventory({ srcRoot: fileURLToPath(new URL('../../../', import.meta.url)) }))
  .map(({ root: _root, ...entry }) => Object.freeze(entry)));

export function generateFlueSpecialists(opts) {
  const cloudflare = opts.flueTarget === 'cloudflare';
  const selected = specialists(selectedFlueBundles(opts));
  const definitions = selected.map(specialist => {
    const logical = path.join(specialist.root, 'agents', specialist.file);
    const file = opts.mapInputPath?.(logical) || logical;
    const { body, metadata } = parseFrontmatter(injectBoundRules(fs.readFileSync(file, 'utf8'), file, opts));
    if (opts.packageOutput) return `export function ${specialist.exportName}(options) {
  return createSpecialist({ name: ${JSON.stringify(specialist.name)}, description: ${JSON.stringify(metadata.description || metadata.name)}, agent() { return ${JSON.stringify(body.trim())}; } }, options);
}`;
    return `export const ${specialist.exportName} = defineSubagent({
  name: ${JSON.stringify(specialist.name)},
  description: ${JSON.stringify(metadata.description || metadata.name)},
  agent() {
    ${cloudflare ? '' : `useTool(aiwg_discover);
    useTool(aiwg_show);
    useTool(aiwg_artifact_write);`}
    return ${JSON.stringify(body.trim())};
  },
});`;
  });
  if (opts.packageOutput) {
    const bundles = selectedFlueBundles(opts);
    const groups = bundles.map(bundle => ({ name: `${camel(bundle.id === 'sdlc-complete' ? 'sdlc' : bundle.id)}Specialists`, members: specialists([bundle]) }));
    if (opts.declarations) return `import type { SubagentDefinition, McpConnectionDefinition } from '@flue/runtime';\nimport type { SpecialistOptions } from './specialist-binding.js';\nexport type { SpecialistOptions } from './specialist-binding.js';\nexport declare function bindRemoteSpecialist(definition: SubagentDefinition, connection: McpConnectionDefinition): SubagentDefinition;\n${selected.map(s => `export declare function ${s.exportName}(options?: SpecialistOptions): SubagentDefinition;`).join('\n')}\n${groups.map(g => `export declare function ${g.name}(options?: SpecialistOptions): SubagentDefinition[];`).join('\n')}\n`;
    return `import { createSpecialist } from './specialist-binding.js';\nexport { bindRemoteSpecialist } from './remote-specialist.js';\n${definitions.join('\n\n')}\n${groups.map(g => `export function ${g.name}(options) { return [${g.members.map(s => `${s.exportName}(options)`).join(', ')}]; }`).join('\n')}\n`;
  }
  return `// Curated AIWG delegates; regenerate from canonical sdlc-complete agents.
import { defineSubagent, useSubagent${cloudflare ? '' : ', useTool'} } from '@flue/runtime';
import { ${cloudflare ? 'aiwgConnection, bindRemoteSpecialist' : 'aiwg_discover, aiwg_show, aiwg_artifact_write'} } from './tools.ts';

${definitions.join('\n\n')}

/** Trusted app options: omit pins to inherit the app model and effort. */
export function useAiwgSpecialists(pins: { ${selected.map(({ exportName }) => `${exportName}?: string`).join('; ')} } = {}) {
${selected.map(({ exportName }) => `  useSubagent(${cloudflare ? 'bindRemoteSpecialist(' : ''}pins.${exportName} === undefined ? ${exportName} : { ...${exportName}, model: pins.${exportName} }${cloudflare ? ', aiwgConnection())' : ''});`).join('\n')}
}
`;
}

export function deployFlueSpecialists(target, opts) {
  // Preserve operator files even on --force. Unchanged managed outputs can refresh.
  const write = (relative, content) => {
    const file = path.join(target, relative);
    if (fs.lstatSync(file, { throwIfNoEntry: false })) {
      if (!claimRecordedFile(target, file, opts)) {
        console.warn(`Flue (experimental): keeping existing module ${opts.logicalOutputPath?.(file) || file}; remove this file manually and redeploy to generate it for the current target.`);
        return;
      }
    }
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content());
    }
  };
  const template = fileURLToPath(new URL('../../../agentic/code/providers/flue/templates/aiwg/tools.ts', import.meta.url));
  if (opts.flueTarget === 'cloudflare' && !opts.fluePackage) {
    for (const ext of ['js', 'd.ts']) write(`src/aiwg/remote-specialist.${ext}`, () =>
      fs.readFileSync(new URL(`../../../packages/flue/remote-specialist.${ext}`, import.meta.url), 'utf8'));
  }
  write('src/aiwg/tools.ts', () => opts.flueTarget === 'cloudflare' ? cloudflareTools(opts) : opts.fluePackage ? "export * from '@aiwg/flue/tools/node';\n" : fs.readFileSync(opts.mapInputPath?.(template) || template, 'utf8'));
  write('src/aiwg/specialists.ts', () => generateFlueSpecialists(opts));
  write('src/aiwg/skills.ts', () => generateFlueSkills(target, opts));
}
