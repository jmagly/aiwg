// Verify canonical generation, tool isolation and model inheritance without a model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error provider deploy module
import { FLUE_SPECIALISTS, generateFlueSpecialists, deployFlueSpecialists } from '../../../tools/agents/providers/flue-specialists.mjs';
let root: string;
let source: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-specialists-'));
  source = path.join(root, 'sdlc-complete');
  fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
  for (const { file } of FLUE_SPECIALISTS) fs.writeFileSync(path.join(source, 'agents', file),
    `---\nname: Synthetic\ndescription: Synthetic specialist\nmodel: sonnet\ntools: Bash, Write\n---\nBody for ${file}: \u0060code\u0060 and \u0024{literal}.\n`);
  vi.stubEnv('AIWG_ROOT', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it('mounts exactly the curated delegates with canonical bodies, bound rules and only AIWG tools', async () => {
  const bindings = new Map(FLUE_SPECIALISTS.map(({ file }: { file: string }) => [path.join(source, 'agents', file),
    [{ name: 'fixture-rule', summary: 'Synthetic rule' }]]));
  const generated = generateFlueSpecialists({ srcRoot: source, ruleDelivery: { bindings } });
  const runtime = path.join(root, 'runtime.mjs');
  fs.writeFileSync(runtime, `export const mounted = [], tools = [];
export const defineSubagent = x => Object.freeze(x);
export const useSubagent = x => mounted.push(x);
export const useTool = x => tools.push(x);`);
  fs.writeFileSync(path.join(root, 'tools.mjs'), `export const aiwg_discover = 'discover', aiwg_show = 'show', aiwg_artifact_write = 'write';`);
  const compiled = ts.transpileModule(generated.replace("'@flue/runtime'", "'./runtime.mjs'").replace("'./tools.ts'", "'./tools.mjs'"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  fs.writeFileSync(path.join(root, 'specialists.mjs'), compiled);
  const module = await import(pathToFileURL(path.join(root, 'specialists.mjs')).href);
  const hooks = await import(pathToFileURL(runtime).href);
  expect(Object.keys(module).sort()).toEqual(['codeReviewer', 'testEngineer', 'useAiwgSpecialists']);
  module.useAiwgSpecialists();
  expect(hooks.mounted.map((x: any) => x.name)).toEqual(['code-reviewer', 'test-engineer']);
  for (const [index, delegate] of hooks.mounted.entries()) {
    expect(delegate).not.toHaveProperty('model');
    expect(delegate).not.toHaveProperty('thinkingLevel');
    const body = delegate.agent();
    expect(body).toContain(`Body for ${FLUE_SPECIALISTS[index].file}: \u0060code\u0060 and \u0024{literal}.`);
    expect(body).toContain('aiwg show rule fixture-rule --body');
    expect(body).not.toContain('model: sonnet');
    expect(body).not.toContain('tools: Bash');
  }
  expect(hooks.tools).toEqual(['discover', 'show', 'write', 'discover', 'show', 'write']);
  module.useAiwgSpecialists({ codeReviewer: 'offline/pinned' });
  expect(hooks.mounted[2].model).toBe('offline/pinned');
  expect(hooks.mounted[3]).not.toHaveProperty('model');
});

it('reads changes at generation time and fails if a canonical specialist is absent', () => {
  const file = path.join(source, 'agents/code-reviewer.md');
  fs.appendFileSync(file, '\nChanged canonical body.\n');
  expect(generateFlueSpecialists({ srcRoot: source })).toContain('Changed canonical body.');
  fs.unlinkSync(file);
  expect(() => generateFlueSpecialists({ srcRoot: source })).toThrow(/ENOENT/);
});

it('keeps operator modules and reports them even with force', () => {
  const target = path.join(root, 'app');
  fs.mkdirSync(path.join(target, 'src/aiwg'), { recursive: true });
  for (const file of ['tools.ts', 'specialists.ts']) fs.writeFileSync(path.join(target, 'src/aiwg', file), '// operator\n');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  deployFlueSpecialists(target, { srcRoot: source, force: true });
  expect(warning).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(path.join(target, 'src/aiwg/specialists.ts'), 'utf8')).toBe('// operator\n');
});
