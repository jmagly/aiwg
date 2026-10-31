// Static imports and bundle mounting are verified with a local Flue runtime double.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { REGISTRY_ID_TO_USE_NAME, frameworkRegistryId } from '../../../src/config/framework-aliases.js';
// @ts-expect-error provider tool module
import { selectedFlueBundles } from '../../../tools/agents/providers/flue-bundles.mjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error provider tool module
import { generateFlueSkills } from '../../../tools/agents/providers/flue-skills.mjs';
// @ts-expect-error provider tool module
import { generateFlueSpecialists } from '../../../tools/agents/providers/flue-specialists.mjs';
let root: string;
const write = (file: string, bytes: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-skill-module-')); vi.stubEnv('AIWG_ROOT', ''); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
it('exports every deployed skill once, groups bundles and mounts their union', async () => {
  const project = path.join(root, 'project');
  const corpus = path.join(root, 'corpus');
  for (const [group, bundle, names] of [['frameworks', 'sdlc-complete', ['review', 'standard']], ['addons', 'voice-framework', ['voice']]] as const) {
    write(path.join(corpus, 'agentic/code', group, bundle, 'manifest.json'), '{}');
    for (const name of names) {
      write(path.join(corpus, 'agentic/code', group, bundle, 'skills', name, 'SKILL.md'), name);
      write(path.join(project, '.agents/skills', name, 'SKILL.md'), name);
    }
  }
  write(path.join(corpus, 'agentic/code/addons/aiwg-utils/manifest.json'), '{}');
  write(path.join(corpus, 'agentic/code/addons/aiwg-utils/skills/utility/SKILL.md'), 'utility');
  write(path.join(project, '.agents/skills/utility/SKILL.md'), 'utility');
  const generated = generateFlueSkills(project, { srcRoot: corpus, mode: 'sdlc', config: { installed: {
    sdlc: { deployedTo: { flue: {} } }, 'voice-framework': { deployedTo: { flue: {} } }, 'aiwg-utils': { deployedTo: { claude: {} } },
  } } });
  expect(generated.match(/^import \w+ from '\.\.\/\.\.\/\.agents\/skills\//gm)).toHaveLength(3);
  expect(generated).toContain("import standard from '../../.agents/skills/standard/SKILL.md'");
  expect(generated).not.toContain('utility');
  for (const name of ['review', 'standard', 'voice']) write(path.join(root, `${name}.mjs`), `export default ${JSON.stringify(name)};`);
  write(path.join(root, 'runtime.mjs'), 'export const mounted = []; export const useSkill = skill => mounted.push(skill);');
  const local = generated.replace("'@flue/runtime'", "'./runtime.mjs'").replace(/'\.\.\/\.\.\/\.agents\/skills\/([^/]+)\/SKILL.md'/g, "'./$1.mjs'");
  write(path.join(root, 'skills.mjs'), ts.transpileModule(local, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  const module = await import(pathToFileURL(path.join(root, 'skills.mjs')).href);
  const runtime = await import(pathToFileURL(path.join(root, 'runtime.mjs')).href);
  expect(module.sdlcSkills).toEqual(['review', 'standard']);
  expect(module.voiceFrameworkSkills).toEqual(['voice']);
  module.useAiwgSkills(module.sdlcSkills, module.voiceFrameworkSkills, module.sdlcSkills);
  expect(runtime.mounted).toEqual(['review', 'standard', 'voice']);
});
it('reads specialists from the selected addon manifest instead of always selecting SDLC', () => {
  const source = path.join(root, 'agentic/code/addons/voice-framework');
  write(path.join(source, 'manifest.json'), JSON.stringify({ flue: { specialists: ['voice-editor'] } }));
  write(path.join(source, 'agents/voice-editor.md'), '---\nname: Voice Editor\ndescription: Review voice\n---\nVoice body.\n');
  const generated = generateFlueSpecialists({ srcRoot: source });
  expect(generated).toContain('export const voiceEditor = defineSubagent(');
  expect(generated).toContain('Voice body.');
  expect(generated).not.toContain('codeReviewer');
});

it.each([...Object.entries(REGISTRY_ID_TO_USE_NAME), ['general', 'general'], ['writing', 'general']])('shares the canonical alias for %s (%s)', (id, alias) => {
  const canonical = frameworkRegistryId(id);
  fs.mkdirSync(path.join(root, 'agentic/code/addons'), { recursive: true });
  write(path.join(root, 'agentic/code/frameworks', canonical, 'manifest.json'), '{}');
  const opts = { srcRoot: root, mode: 'unused', config: { installed: { [id]: { deployedTo: { flue: {} } } } } };
  expect(selectedFlueBundles(opts).map((bundle: { id: string }) => bundle.id)).toEqual([canonical]);
});
