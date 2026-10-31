// Exercise the shipped Node example through public deployment and real Flue lifetimes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
let scratch: string;
afterEach(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

function files(directory: string, relative = ''): string[] {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const name = path.join(relative, entry.name);
    if (['node_modules', 'dist'].includes(entry.name)) return [];
    return entry.isDirectory() ? files(directory, name) : [name];
  });
}

it('discovers, shows rules, activates, delegates, writes, resumes, aborts and removes without changing the example', () => {
  const example = path.join(ROOT, 'examples/flue-node');
  // CI provisions the locked graph before this release-slow lane. Locally a
  // read-only lab may supply it; no install, credential file, or model is used.
  const dependencies = path.resolve(process.env.AIWG_FLUE_DEPENDENCIES || example, 'node_modules');
  expect(fs.existsSync(dependencies), 'Provision examples/flue-node with npm ci, or set AIWG_FLUE_DEPENDENCIES to a locked Flue 2.3.0 project').toBe(true);
  for (const [name, version] of [['@flue/runtime', '2.3.0'], ['@earendil-works/pi-ai', '1.4.0']]) {
    expect(JSON.parse(fs.readFileSync(path.join(dependencies, name, 'package.json'), 'utf8')).version).toBe(version);
  }
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-node-'));
  const project = path.join(scratch, 'project'), home = path.join(scratch, 'home'), bin = path.join(scratch, 'bin');
  const originals = new Map(files(example).map(name => [name, fs.readFileSync(path.join(example, name))]));
  fs.cpSync(example, project, { recursive: true, filter: source => !['node_modules', 'dist'].includes(path.basename(source)) });
  fs.cpSync(dependencies, path.join(project, 'node_modules'), {
    recursive: true, filter: source => !source.split(path.sep).includes('.cache'),
  });
  fs.mkdirSync(path.join(home, '.aiwg'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(home, '.aiwg/channel.json'), JSON.stringify({ channel: 'edge', edgePath: ROOT, devMode: true }));
  const cli = path.join(ROOT, 'bin/aiwg.mjs');
  const shim = path.join(bin, 'aiwg');
  fs.writeFileSync(shim, `#!${process.execPath}\nimport ${JSON.stringify(cli)};\n`, { mode: 0o755 });
  // A closed environment prevents model credentials or real-HOME settings
  // from entering either the app or its MCP/CLI children.
  const env = { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: home, USERPROFILE: home, TMPDIR: scratch,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.state'),
    AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_USER_REGISTRY_PATH: path.join(home, '.aiwg/installed.json'),
    AIWG_ROOT: ROOT, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_SKIP_ACTIVITY_LOG: '1', NO_UPDATE_NOTIFIER: '1',
  };
  function run(args: string[], timeout = 600_000) {
    const result = spawnSync(process.execPath, args, { cwd: project, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    expect(result.status, `${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
    return result.stdout;
  }
  run([cli, 'use', 'sdlc', '--provider', 'flue']);
  const generated = ['src/aiwg/tools.ts', 'src/aiwg/specialists.ts', 'src/db.ts', 'AGENTS.md', 'WORKSPACE.md', 'AIWG.md'];
  for (const name of generated) expect(fs.existsSync(path.join(project, name)), name).toBe(true);
  expect(fs.existsSync(path.join(project, '.agents/skills/sdlc-quickref/SKILL.md'))).toBe(true);
  const fixture = path.join(ROOT, 'test/fixtures/providers/flue/node-slice-worker.mjs');
  fs.copyFileSync(fixture, path.join(project, 'node-slice-worker.mjs'));
  // Check app, config, generated modules and the complete dependency type graph.
  run([path.join(ROOT, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--allowImportingTsExtensions',
    'src/app.ts', 'src/agents/assistant.ts', 'src/db.ts', 'flue.config.ts', 'vite.config.ts'], 60_000);
  run([path.join(project, 'node_modules/vite/bin/vite.js'), 'build'], 60_000);
  expect(fs.existsSync(path.join(project, 'dist/server.mjs'))).toBe(true);
  for (const mode of ['first', 'restart']) expect(run(['node-slice-worker.mjs', mode], 180_000)).toContain(`PASS Node slice ${mode}`);
  const artifacts = path.join(project, '.aiwg');
  expect(fs.readFileSync(path.join(artifacts, 'reviews/example.md'), 'utf8')).toBe('Code Reviewer: use a + b.\n');
  expect(fs.existsSync(path.join(project, 'reviews/example.md'))).toBe(false);
  expect(fs.readFileSync(path.join(project, '.flue-state/state.db')).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  expect(fs.existsSync(path.join(project, 'node_modules/.cache'))).toBe(false);
  // Run the manual lab's durability suite in CI against an independent store,
  // so its competing owners and synthetic effects cannot affect the app test.
  const durability = path.join(scratch, 'durability');
  fs.mkdirSync(durability);
  fs.cpSync(path.join(project, 'src'), path.join(durability, 'src'), { recursive: true });
  fs.symlinkSync(path.join(project, 'node_modules'), path.join(durability, 'node_modules'), 'dir');
  const fixtureUrl = (name: string) => pathToFileURL(path.join(ROOT, 'test/fixtures/providers/flue', name)).href;
  fs.writeFileSync(path.join(durability, 'check.mjs'), `
import assert from 'node:assert/strict';
import { prepareProject } from ${JSON.stringify(fixtureUrl('project.mjs'))};
import { assertDurability } from ${JSON.stringify(fixtureUrl('durability-checks.mjs'))};
globalThis.fetch = () => { throw new Error('Network forbidden'); };
let passed = 0;
await assertDurability(import.meta.dirname, await prepareProject(import.meta.dirname), async (name, check) => {
  await check();
  passed++;
  console.log('PASS ' + name);
});
assert.equal(passed, 8);
console.log('PASS durability checks: ' + passed);
`);
  // Each worker has a 30s hard stop; allow all lifetimes room on hosted runners.
  expect(run([path.join(durability, 'check.mjs')], 300_000)).toContain('PASS durability checks: 8');
  const interrupted = path.join(ROOT, 'test/fixtures/providers/flue/interrupted-server.mjs');
  fs.writeFileSync(shim, `#!${process.execPath}\nimport ${JSON.stringify(interrupted)};\n`);
  for (const mode of ['abort', 'reconcile']) expect(run(['node-slice-worker.mjs', mode], 60_000)).toContain(`PASS Node slice ${mode}`);
  const state = fs.readFileSync(path.join(project, '.flue-state/state.db'));
  run([cli, 'remove', 'sdlc']);
  for (const name of generated) expect(fs.existsSync(path.join(project, name)), name).toBe(false);
  expect(fs.existsSync(path.join(project, '.agents/skills/sdlc-quickref'))).toBe(false);
  expect(fs.existsSync(path.join(project, '.agents'))).toBe(false);
  for (const [name, bytes] of originals) expect(fs.readFileSync(path.join(project, name)), name).toEqual(bytes);
  expect(fs.readFileSync(path.join(project, '.flue-state/state.db'))).toEqual(state);
  expect(fs.readFileSync(path.join(artifacts, 'reviews/example.md'), 'utf8')).toBe('Code Reviewer: use a + b.\n');
}, 1_500_000);
