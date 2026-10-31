#!/usr/bin/env node
// Stage the peer-only Flue surface using the existing provider generators.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { fluePackageSkills } from './flue-package-files.mjs';
import { validateFlueSkill } from '../agents/providers/flue-validation.mjs';
import { deploySkillDir } from '../agents/providers/base-skill-copy.mjs';
import { generateFlueSpecialists } from '../agents/providers/flue-specialists.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
export function buildFluePackage({ outputDir = path.join(root, 'dist/packages/flue') } = {}) {
  const source = path.join(root, 'packages/flue');
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (pkg.name !== '@aiwg/flue' || pkg.version !== version) throw new Error(`@aiwg/flue version ${pkg.version} must exactly match root ${version}`);
  if (pkg.dependencies || pkg.optionalDependencies || JSON.stringify(pkg.peerDependencies) !== JSON.stringify({ '@flue/runtime': '2.3.x' })) throw new Error('@aiwg/flue must depend only on its Flue 2.3.x peer');
  const { bundles, skills } = fluePackageSkills(root);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  for (const file of fs.readdirSync(source).filter(file => /\.(?:js|ts|md)$/.test(file))) fs.copyFileSync(path.join(source, file), path.join(outputDir, file));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(outputDir, 'LICENSE'));
  for (const [name, directory] of skills) {
    deploySkillDir(directory, path.join(outputDir, 'skills'), { provider: 'flue', srcRoot: root, quiet: true, deployVersion: version });
    const target = path.join(outputDir, 'skills', name, 'SKILL.md');
    validateFlueSkill(fs.readFileSync(target, 'utf8'), target);
    fs.writeFileSync(`${target}.d.ts`, "import type { SkillReference } from '@flue/runtime';\ndeclare const skill: SkillReference;\nexport default skill;\n");
    pkg.exports[`./skills/${name}/SKILL.md`] = { types: `./skills/${name}/SKILL.md.d.ts`, default: `./skills/${name}/SKILL.md` };
  }
  // Deployment receipts are local state, never package payload.
  const clean = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name.startsWith('.aiwg')) fs.rmSync(file, { recursive: true, force: true });
      else if (entry.isDirectory()) clean(file);
    }
  };
  clean(outputDir);
  const opts = { srcRoot: root, packageOutput: true, config: { installed: Object.fromEntries(bundles.map(bundle => [bundle.id, { deployedTo: { flue: {} } }])) } };
  fs.writeFileSync(path.join(outputDir, 'specialists.js'), generateFlueSpecialists(opts));
  fs.writeFileSync(path.join(outputDir, 'specialists.d.ts'), generateFlueSpecialists({ ...opts, declarations: true }));
  const template = fs.readFileSync(path.join(root, 'agentic/code/providers/flue/templates/aiwg/tools.ts'), 'utf8')
    .replace("import * as v from 'valibot';", "import { v, Client, StdioClientTransport, getDefaultEnvironment } from './node-dependencies.js';")
    .replace(/^import .* from '@modelcontextprotocol\/client(?:\/stdio)?';\n/gm, '');
  fs.writeFileSync(path.join(outputDir, 'node.js'), ts.transpileModule(template, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  fs.writeFileSync(path.join(outputDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return { outputDir, version, skills: skills.size };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--output');
    const result = buildFluePackage(index < 0 ? {} : { outputDir: path.resolve(process.argv[index + 1]) });
    console.log(`Built @aiwg/flue ${result.version}: ${result.skills} skill exports at ${result.outputDir}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
