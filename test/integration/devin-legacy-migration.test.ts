// Build the pre-native layout through the real CLI before exercising upgrade paths.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const repo = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(repo, 'test/fixtures/providers/devin-legacy');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-devin-migration-'));
const legacyRuntime = path.join(root, 'legacy-runtime');
const legacyProject = path.join(root, 'legacy-project');
let legacyFiles: string[];

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
function run(runtime: string, project: string, args: string[]) {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const result = spawnSync(process.execPath, [path.join(runtime, 'bin/aiwg.mjs'), ...args], {
    cwd: project, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), AIWG_CONFIG: path.join(home, '.aiwg'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
  const output = `${result.stdout}\n${result.stderr}\n${result.error || ''}`;
  expect(result.status, output).toBe(0);
  return output;
}

beforeAll(() => {
  fs.mkdirSync(legacyRuntime);
  fs.mkdirSync(legacyProject);
  // Copy code and corpus so index discovery traverses real directories.
  for (const dir of ['bin', 'tools', 'dist', 'agentic']) fs.cpSync(path.join(repo, dir), path.join(legacyRuntime, dir), { recursive: true });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(legacyRuntime, 'package.json'));
  for (const dir of ['prebuilt', 'schemas', 'vscode-extension', 'node_modules']) {
    fs.symlinkSync(path.join(repo, dir), path.join(legacyRuntime, dir), 'dir');
  }
  const providers = path.join(legacyRuntime, 'tools/agents/providers');
  for (const [source, dest] of [['adapter.mjs', 'windsurf.mjs'], ['context.mjs', 'devin-legacy-context.mjs'], ['transforms.mjs', 'devin-legacy-transforms.mjs']]) {
    fs.copyFileSync(path.join(fixture, source), path.join(providers, dest));
  }
  const seeds = path.join(legacyRuntime, 'dist/src/providers/provider-seeds-3.js');
  const layout = fs.readFileSync(path.join(fixture, 'layout.json'), 'utf8');
  fs.appendFileSync(seeds, `\nObject.assign(BUILT_IN_SEEDS_3.find(seed => seed.id === 'devin'), ${layout});\n`);
  const commands = path.join(legacyRuntime, 'dist/src/plugin/skill-command-frontmatter.js');
  fs.appendFileSync(commands, "\nPROVIDERS_NEEDING_COMMANDS.add('devin'); SKILLS_ONLY_PROVIDERS.delete('devin');\n");
  // The frozen adapter uses the old rule/behavior surfaces too.
  const behaviors = path.join(providers, 'base-behaviors.mjs');
  fs.writeFileSync(behaviors, fs.readFileSync(behaviors, 'utf8').replaceAll('.devin/rules', '.windsurf/rules'));
  const bindings = path.join(providers, 'rule-delivery-surface.mjs');
  fs.writeFileSync(bindings, fs.readFileSync(bindings, 'utf8').replace('`.${provider.name}/RULES-BOUND.md`', "`.${provider.name === 'devin' ? 'windsurf' : provider.name}/RULES-BOUND.md`"));
  run(legacyRuntime, legacyProject, ['use', 'all', '--provider', 'devin', '--copy-all']);
  legacyFiles = files(path.join(legacyProject, '.windsurf'));
  expect(legacyFiles.length).toBeGreaterThan(2000);
  expect(legacyFiles.filter(file => file.endsWith('/.aiwg-managed')).length).toBeGreaterThan(500);
  expect(fs.existsSync(path.join(legacyProject, '.devin/agents'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(legacyProject, '.aiwg/aiwg.config'), 'utf8')).providers).toEqual(['devin']);
}, 360_000);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('native Devin upgrade from a real legacy copy deployment', () => {
  it.each([
    { provider: 'devin', command: 'use' },
    { provider: 'windsurf', command: 'refresh' },
  ])('$command with $provider retires managed legacy output without losing bytes', ({ provider, command }) => {
    const project = fs.mkdtempSync(path.join(root, 'project-'));
    fs.cpSync(legacyProject, project, { recursive: true });
    const operator = path.join(project, '.windsurf/rules/operator.md');
    fs.writeFileSync(operator, '# Operator rule\n');
    const edited = path.relative(legacyProject, legacyFiles.find(file => file.endsWith('/SKILL.md'))!);
    fs.appendFileSync(path.join(project, edited), '\nOperator edit retained during migration.\n');
    const before = Object.fromEntries(files(path.join(project, '.windsurf')).map(file => [path.relative(project, file), fs.readFileSync(file)]));
    const output = run(repo, project, command === 'use'
      ? ['use', 'all', '--provider', provider, '--copy-all']
      : ['refresh', '--skip-update', '--provider', provider]);
    expect(output).toContain('Migrated'); // Confirms this branch's migration ran.
    expect(output).toContain('Preserved operator files under .windsurf/');
    if (provider === 'windsurf') expect(output).toContain("Provider id 'windsurf' is deprecated");
    expect(files(path.join(project, '.windsurf')).map(file => path.relative(project, file))).toEqual(['.windsurf/rules/operator.md']);
    expect(fs.readFileSync(operator, 'utf8')).toBe('# Operator rule\n');
    const saved = JSON.parse(gunzipSync(fs.readFileSync(path.join(project, '.devin/.aiwg/legacy-windsurf/originals.json.gz'))).toString('utf8'));
    for (const [file, bytes] of Object.entries(before)) {
      if (file === '.windsurf/rules/operator.md') continue;
      const archived = saved[path.relative('.windsurf', file)];
      expect(Buffer.from(archived.bytes, 'base64').equals(bytes), file).toBe(true);
    }
    for (const dir of ['agents', 'skills', 'rules']) expect(files(path.join(project, '.devin', dir)).length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(path.join(project, '.devin/mcp_config.json'), 'utf8')).mcpServers.aiwg).toEqual({ command: 'aiwg', args: ['mcp', 'serve'] });
    expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toContain('.devin/rules/RULES-INDEX.md');
    expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).not.toContain('.windsurf/rules/');
  }, 660_000);
});
