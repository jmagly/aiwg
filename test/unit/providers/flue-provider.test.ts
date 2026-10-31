import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveSourceRoot, discoverProjectEntry } from '../../fixtures/providers/flue-discovery.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
// @ts-expect-error deployment tool module
import flue from '../../../tools/agents/providers/flue.mjs';
// @ts-expect-error deployment tool module
import { deployFlueDatabase, flueDeploymentFiles } from '../../../tools/agents/providers/flue-project.mjs';
import { captureDeploymentOutputs, deploymentOutputRoots, recordDeploymentOutputs } from '../../../src/providers/deployment-ownership.mjs';
import { planDeploymentRemoval } from '../../../src/providers/deployment-removal.js';
import { applyRemovalTransaction } from '../../../src/providers/removal-transaction.js';
import { getProviderDefinition } from '../../../src/providers/provider-definitions.js';
import { generate } from '../../../src/smiths/context-pipeline/generator.js';
import { writeFlueContext } from '../../../src/smiths/context-pipeline/flue-context.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
let scratch: string, project: string, source: string;
const read = (file: string) => fs.readFileSync(path.join(project, file), 'utf8');
const write = (base: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
  fs.writeFileSync(path.join(base, file), content);
};
const files = (base: string): string[] => fs.readdirSync(base, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(path.join(base, entry.name)) : [path.join(base, entry.name)]);
const snapshot = () => Object.fromEntries(files(project).map(file => [path.relative(project, file), fs.readFileSync(file).toString('base64')]));
const receipt = () => JSON.parse(read('.aiwg/.aiwg-manifest.json'));
const options = () => ({ srcRoot: source, target: project, mode: 'sdlc', frameworkSlug: 'sdlc-complete',
  provider: 'flue', deploySkills: true, deployVersion: '1', quiet: true, deployBehaviors: false });

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-'));
  project = path.join(scratch, 'project'); fs.mkdirSync(project);
  source = path.join(scratch, 'agentic/code/frameworks/sdlc-complete');
  for (const name of ['code-reviewer', 'test-engineer']) write(source, `agents/${name}.md`, `---\nname: ${name}\ndescription: Synthetic ${name}\n---\nSynthetic ${name} body.\n`);
  write(source, 'skills/demo/SKILL.md', '---\nname: demo\ndescription: Synthetic Flue skill\nkernel: true\nplatforms: [all]\n---\nUse the synthetic skill.\n');
  write(source, 'skills/bulk/SKILL.md', '---\nname: bulk\ndescription: Discovery only\n---\nBulk.\n');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(scratch, { recursive: true, force: true }); });

async function deploy() {
  const roots = deploymentOutputRoots(flue, project), before = captureDeploymentOutputs(roots);
  await flue.deploy(options());
  recordDeploymentOutputs(before, roots, options());
}
async function remove() {
  const plan = planDeploymentRemoval(project, 'flue', 'sdlc-complete');
  await applyRemovalTransaction(plan.writes);
}

describe('Flue experimental deployment and lifecycle', () => {
  it('registers only the implemented app surfaces', () => {
    const definition = getProviderDefinition('flue')!;
    expect(definition.status).toBe('experimental');
    expect(definition.detection.process).toEqual([]);
    expect(definition.paths.kernelSkills).toBe('.agents/skills');
    expect(definition.adapters.mcpInjection).toBeNull();
    expect(Object.values(definition.capabilities.nativeFeatures)).not.toContain(true);
  });

  it.each(['', 'src', '.flue'])('deploys kernel skills, inline context, database and receipts (source: %s)', async dir => {
    if (dir) fs.mkdirSync(path.join(project, dir));
    await deploy();
    const skill = read('.agents/skills/demo/SKILL.md');
    const metadata = parse(skill.match(/^---\n([\s\S]*?)\n---/)![1]);
    // Flue 2.3.0 documented parser constraints; no Flue dev dependency is installed here.
    expect(metadata.name).toBe('demo');
    expect(metadata.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(metadata.name.length).toBeLessThanOrEqual(64);
    expect(metadata.description.length).toBeLessThanOrEqual(1024);
    expect(metadata.platforms).toEqual(['flue']);
    expect(fs.existsSync(path.join(project, '.agents/skills/bulk'))).toBe(false);
    const context = read('AGENTS.md');
    expect(context).toContain('## AIWG Context Graph');
    expect(context).toContain('Context Finalization');
    expect(context).toContain('anti-laziness');
    expect(context).toContain('no-attribution');
    expect(context).not.toContain('Read and follow [WORKSPACE.md]');
    const dbDir = dir || 'src';
    const state = path.posix.join('..', '.flue-state/state.db');
    expect(read(path.join(dbDir, 'db.ts'))).toContain(`new URL(${JSON.stringify(state)}, import.meta.url)`);
    expect(read('.gitignore')).toBe('.flue-state/\n');
    expect(discoverProjectEntry(resolveSourceRoot(project), 'db')).toBe(path.join(project, dbDir, 'db.ts'));
    for (const name of ['AGENTS.md', 'AIWG.md', 'WORKSPACE.md', path.join(dbDir, 'db.ts'), '.gitignore', 'src/aiwg/tools.ts', 'src/aiwg/specialists.ts']) {
      expect(receipt().managed[name]).toMatchObject({ owners: ['sdlc-complete'], filePreimage: { present: false } });
    }
    const skillReceipt = JSON.parse(read('.agents/skills/demo/.aiwg-manifest.json'));
    expect(skillReceipt.managed['SKILL.md'].owners).toEqual(['sdlc-complete']);
  }, 60_000);

  it('keeps src app and database entries discoverable without claiming a .flue directory', async () => {
    write(project, 'src/app.ts', 'export default {};\n');
    const before = resolveSourceRoot(project);
    await deploy();
    expect(before).toBe(path.join(project, 'src'));
    expect(resolveSourceRoot(project)).toBe(before);
    expect(discoverProjectEntry(before, 'app')).toBe(path.join(project, 'src/app.ts'));
    expect(discoverProjectEntry(before, 'db')).toBe(path.join(project, 'src/db.ts'));
    expect(fs.existsSync(path.join(project, '.flue'))).toBe(false);
    expect(read('.gitignore')).toBe('.flue-state/\n');
    expect(Object.keys(receipt().managed).some(name => name === '.flue' || name.startsWith('.flue/'))).toBe(false);
  }, 60_000);

  it.each(['', 'src', '.flue', 'nested/source'])('anchors generated SQLite to the project root from %s', dir => {
    const file = path.join(dir, 'db.ts');
    deployFlueDatabase(project, { flueDatabaseFile: file });
    // A local module double captures sqlite's argument without opening a database.
    write(project, 'node_modules/@flue/runtime/package.json', JSON.stringify({
      type: 'module', exports: { './node': './node.mjs' },
    }));
    write(project, 'node_modules/@flue/runtime/node.mjs', 'export const sqlite = file => file;\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'console.log((await import(process.argv[1])).default)', pathToFileURL(path.join(project, file)).href], {
      cwd: scratch, encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(project, '.flue-state/state.db'));
    expect(fs.existsSync(path.join(project, '.flue-state'))).toBe(false);
  });

  it.each([false, true])('restores every original file after deploy and remove (operator files: %s)', async operator => {
    write(project, 'src/app.ts', 'export const app = "operator";\n');
    if (operator) {
      write(project, 'src/db.ts', '// operator database\n');
      write(project, 'AGENTS.md', '# Operator instructions\nKeep this exact whitespace.  \n');
      write(project, '.gitignore', 'dist/');
    }
    const before = snapshot();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deploy();
    await deploy();
    if (operator) {
      expect(read('src/db.ts')).toBe('// operator database\n');
      expect(receipt().managed['src/db.ts']).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('keeping existing database module'));
      expect(read('AGENTS.md')).toMatch(/^# Operator instructions\nKeep this exact whitespace\.  \n/);
    }
    await remove();
    expect(snapshot()).toEqual(before);
  }, 60_000);

  it('refreshes the inline composition through the public context generator, preserving surrounding bytes', async () => {
    await deploy();
    fs.appendFileSync(path.join(project, 'AGENTS.md'), '\nOperator suffix.\n');
    write(project, 'WORKSPACE.md', '# Operator workspace\nA unique operator policy.\n');
    await generate({ provider: 'flue', projectPath: project, sections: [], detectExistingFiles: true });
    expect(read('AGENTS.md')).toContain('A unique operator policy.');
    expect(read('AGENTS.md')).toMatch(/Operator suffix\.\n$/);
    expect(read('AGENTS.md').match(/AIWG:flue-context:start/g)).toHaveLength(1);
  }, 60_000);

  it('keeps resident memory in its canonical projection and removes legacy inline copies', () => {
    const resident = '<!-- AIWG:resident-memory:start -->\nReviewed resident fact.\n<!-- AIWG:resident-memory:end -->';
    write(project, 'WORKSPACE.md', `# Workspace\nKeep operator policy.\n${resident}\n`);
    write(project, 'AIWG.md', '# Framework discovery\n');
    write(project, 'AGENTS.md', `Operator prefix.\n<!-- AIWG:flue-context:start -->\n${resident}\n<!-- AIWG:flue-context:end -->\nOperator suffix.\n`);
    const context = writeFlueContext(project);
    expect(context).not.toContain('Reviewed resident fact.');
    expect(context).not.toContain('AIWG:resident-memory:');
    expect(context).toContain('Keep operator policy.');
    expect(context).toContain('# Framework discovery');
    expect(context).toMatch(/^Operator prefix\.\n/);
    expect(context).toMatch(/Operator suffix\.\n$/);
    expect(read('WORKSPACE.md')).toContain(resident);
    expect(writeFlueContext(project)).toBe(context);
  });

  it('preserves operator skills and another provider mirror outside its kernel set', async () => {
    write(project, '.agents/skills/bulk/SKILL.md', 'Operator native skill.\n');
    write(project, '.agents/.aiwg/skills/bulk/SKILL.md', 'Another provider mirror.\n');
    const before = snapshot();
    await deploy();
    await remove();
    expect(snapshot()).toEqual(before);
  }, 60_000);

  it('preserves edited generated files during removal', async () => {
    await deploy();
    fs.appendFileSync(path.join(project, 'src/db.ts'), '// operator change\n');
    fs.appendFileSync(path.join(project, 'src/aiwg/specialists.ts'), '// operator specialist change\n');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deploy();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('keeping existing module'));
    const plan = planDeploymentRemoval(project, 'flue', 'sdlc-complete');
    expect(plan.decisions).toContainEqual(expect.objectContaining({ path: path.join(project, 'src/aiwg/specialists.ts'), action: 'preserve', reason: 'edited generated file; preserved' }));
    await applyRemovalTransaction(plan.writes);
    expect(read('src/db.ts')).toContain('operator change');
    expect(read('src/aiwg/specialists.ts')).toContain('operator specialist change');
  }, 60_000);

  it('keeps generated database and ignore outputs until their last framework owner is removed', async () => {
    await deploy();
    await flue.deploy({ ...options(), frameworkSlug: 'marketing' });
    for (const file of ['src/db.ts', 'src/aiwg/tools.ts', 'src/aiwg/specialists.ts'])
      expect(receipt().managed[file].owners).toEqual(['marketing', 'sdlc-complete']);
    await remove();
    expect(read('src/db.ts')).toContain('sqlite');
    expect(read('.gitignore')).toBe('.flue-state/\n');
    await applyRemovalTransaction(planDeploymentRemoval(project, 'flue', 'marketing').writes);
    expect(fs.existsSync(path.join(project, 'src/db.ts'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
    for (const file of ['tools.ts', 'specialists.ts']) expect(fs.existsSync(path.join(project, 'src/aiwg', file))).toBe(false);
  }, 60_000);

  it('keeps operator context additions through a redeploy and removal', async () => {
    await deploy();
    fs.appendFileSync(path.join(project, 'AGENTS.md'), '\nOperator addition.\n');
    await deploy();
    fs.appendFileSync(path.join(project, 'AGENTS.md'), '\nSecond operator edit.\n');
    const before = read('AGENTS.md'), record = receipt().managed['AGENTS.md'];
    const plan = planDeploymentRemoval(project, 'flue', 'sdlc-complete');
    expect(plan.decisions).toContainEqual(expect.objectContaining({ path: path.join(project, 'AGENTS.md'),
      action: 'preserve', reason: 'edited generated file; preserved' }));
    expect(plan.remaining).toContainEqual(record);
    expect(plan.writes.some(write => write.path === path.join(project, 'AGENTS.md'))).toBe(false);
    await applyRemovalTransaction(plan.writes);
    expect(read('AGENTS.md')).toBe(before);
    expect(receipt().managed['AGENTS.md']).toEqual(record);
  }, 60_000);

  it('does not mutate a dry run or accept user scope', async () => {
    await flue.deploy({ ...options(), dryRun: true });
    expect(snapshot()).toEqual({});
    await expect(flue.deploy({ ...options(), userScope: true })).rejects.toThrow('project scope only');
  }, 60_000);

  it.each(['db.mjs', 'src/db.js', '.flue/db.mts'])('keeps existing operator database formats (%s)', file => {
    write(project, file, 'operator');
    deployFlueDatabase(project, { dryRun: false });
    expect(read(file)).toBe('operator');
    expect(files(project).filter(file => file.endsWith('db.ts'))).toEqual([]);
  });

  it.each(['src', '.flue'])('reports the database in %s ahead of a stray root module in staged deployment', async dir => {
    write(project, 'db.mjs', '// stray root database\n');
    write(project, 'src/db.ts', '// operator src database\n');
    if (dir === '.flue') write(project, '.flue/db.mts', '// operator flue database\n');
    const selected = dir === '.flue' ? '.flue/db.mts' : 'src/db.ts';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deploy();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`keeping existing database module ${path.join(project, selected)};`));
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining(`module ${path.join(project, 'db.mjs')};`));
    expect(receipt().managed[selected]).toBeUndefined();
    expect(read('db.mjs')).toBe('// stray root database\n');
    expect(discoverProjectEntry(resolveSourceRoot(project), 'db')).toBe(path.join(project, selected));
  }, 60_000);

  it.each(['.flue-state', '.flue-state/', '.flue-state/*', '.flue-state/**',
    '/.flue-state', '/.flue-state/', '/.flue-state/*', '/.flue-state/**'])('keeps equivalent ignore rule %s byte-exact', rule => {
    const before = `dist/\r\n ${rule} \r\n`;
    write(project, '.gitignore', before);
    deployFlueDatabase(project, {});
    expect(read('.gitignore')).toBe(before);
  });

  it.each(['db: "./custom/database.ts"', '"db": customDatabase', "'db' /* operator */ : resolveDatabase()"])(
    'preserves an explicit config entry without evaluating it (%s)', entry => {
      const config = `throw new Error('must never evaluate');\nexport default { ${entry} };\n`;
      write(project, 'flue.config.ts', config);
      write(project, '.gitignore', 'dist/');
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deployFlueDatabase(project, {});
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('keeping explicit db entry in flue.config.ts'));
      expect(snapshot()).toEqual({ 'flue.config.ts': Buffer.from(config).toString('base64'), '.gitignore': Buffer.from('dist/').toString('base64') });
    });

  it.each(['// db: "custom"', '/* db: "custom" */', 'export default { note: "db: custom" };',
    'export default { note: `db: custom` };', 'export default { nested: { db: "./x" } };',
    'export default defineConfig({ nested: { "db": "./x" } });',
    'const other = { db: "./x" }; export default {};',
    'export default {}; const other = { db: "./x" };',
    'export default { nested: [{ db: "./x" }] };'])(
    'ignores config content outside top-level exported keys (%s)', config => {
      write(project, 'flue.config.ts', config);
      deployFlueDatabase(project, {});
      expect(read('src/db.ts')).toContain('sqlite');
      expect(read('.gitignore')).toBe('.flue-state/\n');
  });

  it.each(['export default { nested: { db: "./nested" }, db: "./custom" };',
    'export default defineConfig({ nested: { db: "./nested" }, "db": "./custom" });',
    'export default ({ db: "./custom" });', 'module.exports = { db: "./custom" };'])(
    'respects top-level exported db keys (%s)', config => {
      write(project, 'flue.config.ts', config);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      deployFlueDatabase(project, {});
      expect(snapshot()).toEqual({ 'flue.config.ts': Buffer.from(config).toString('base64') });
    });

  const configExtensions = ['ts', 'mts', 'mjs', 'js', 'cjs', 'cts'];
  it.each(configExtensions.slice(0, -1))('uses Flue config priority after .%s', ext => {
    const next = configExtensions[configExtensions.indexOf(ext) + 1];
    write(project, `flue.config.${ext}`, 'export default {};\n');
    write(project, `flue.config.${next}`, 'export default { db: "./unused" };\n');
    deployFlueDatabase(project, {});
    expect(read('src/db.ts')).toContain('sqlite');
  });

  it.each(configExtensions.flatMap(ext => [false, true].map(ignore => ({ ext, ignore }))))(
    'respects a config-pointed db through staged deploy/remove (.$ext, ignore: $ignore)', async ({ ext, ignore }) => {
      const config = `flue.config.${ext}`;
      write(project, 'src/app.ts', 'export default {};\n');
      write(project, config, `${['cjs', 'cts'].includes(ext) ? 'module.exports =' : 'export default'} { db: "./custom/database.ts" };\n`);
      write(project, 'custom/database.ts', '// operator database\n');
      if (ignore) write(project, '.gitignore', 'dist/');
      const before = snapshot();
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await deploy();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(`keeping explicit db entry in ${config}`));
      expect(fs.existsSync(path.join(project, 'src/db.ts'))).toBe(false);
      expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(ignore);
      if (ignore) expect(read('.gitignore')).toBe('dist/');
      for (const name of ['src/db.ts', '.gitignore', config]) expect(receipt().managed[name]).toBeUndefined();
      await remove();
      expect(snapshot()).toEqual(before);
  }, 60_000);

  it('keeps an existing ignore rule and rejects malformed context markers', () => {
    write(project, '.gitignore', '/.flue-state/\n');
    deployFlueDatabase(project, {});
    expect(read('.gitignore')).toBe('/.flue-state/\n');
    write(project, 'AGENTS.md', '<!-- AIWG:flue-context:start -->');
    expect(() => writeFlueContext(project)).toThrow('Malformed');
    expect(flueDeploymentFiles(project)).toEqual(['src/db.ts', '.gitignore', 'src/aiwg/tools.ts', 'src/aiwg/specialists.ts',
      'flue.config.ts', 'flue.config.mts', 'flue.config.mjs', 'flue.config.js', 'flue.config.cjs', 'flue.config.cts',
      '.flue/db.ts', '.flue/db.mts', '.flue/db.js', '.flue/db.mjs',
      'src/db.mts', 'src/db.js', 'src/db.mjs', 'db.ts', 'db.mts', 'db.js', 'db.mjs']);
  });

  it('governs complete and absent file preimages with the existing provider receipt schema', async () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas/providers/aiwg-provider-transformation-receipt.v1.schema.json'), 'utf8'));
    const ajv = new Ajv({ strict: true }); addFormats(ajv);
    ajv.addSchema(schema);
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/deploymentFilePreimage` });
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/providers/flue-preimages.json'), 'utf8'));
    for (const item of fixture.valid) expect(validate(item), JSON.stringify(validate.errors)).toBe(true);
    for (const item of fixture.invalid) expect(validate(item)).toBe(false);
    expect(validate({ present: true, bytes: '', hash: `sha256:${createHash('sha256').update('').digest('hex')}` })).toBe(true);
    const validateManifest = ajv.compile({ $ref: `${schema.$id}#/$defs/deploymentManifest` });
    const manifests = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/providers/flue-manifests.json'), 'utf8'));
    for (const item of manifests.valid) expect(validateManifest(item), JSON.stringify(validateManifest.errors)).toBe(true);
    for (const item of manifests.invalid) expect(validateManifest(item)).toBe(false);
    await deploy();
    expect(validateManifest(receipt()), JSON.stringify(validateManifest.errors)).toBe(true);
    for (const filePreimage of fixture.invalid) {
      const invalid = receipt(); invalid.managed['AGENTS.md'].filePreimage = filePreimage;
      expect(validateManifest(invalid)).toBe(false);
    }
  });
});
