// Fixture-only regression coverage for read-only provider marketplace search.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { discoverCapability } from '../../../src/artifacts/query-engine.js';
import { marketplaceHandler } from '../../../src/cli/handlers/marketplace.js';

vi.mock('../../../src/skills/registry.js', () => ({ searchSkills: vi.fn(async () => []) }));
vi.mock('../../../src/marketplace/exchange.js', () => ({ searchCatalogs: vi.fn(async () => []) }));
const fixtures = path.resolve('test/fixtures/marketplace-search');
let home: string;
let project: string;
function put(relative: string, data: unknown) {
  const file = path.join(home, '.claude/plugins', relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
}
function fixture(name: string) { return fs.readFileSync(path.join(fixtures, `${name}.json`), 'utf8'); }
function snapshot(directory: string): unknown {
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => [entry.name,
    entry.isDirectory() ? snapshot(path.join(directory, entry.name)) : fs.readFileSync(path.join(directory, entry.name), 'utf8')]);
}
async function run(query: string, flags: string[] = []) {
  const output: string[] = [];
  const warnings: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...args) => warnings.push(args.join(' ')));
  const args = ['search', query, '--plugins', ...flags];
  const status = await marketplaceHandler.execute({ args, rawArgs: ['marketplace', ...args], cwd: project, frameworkRoot: process.cwd() });
  return { status, output: output.join('\n'), warnings: warnings.join('\n') };
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-plugin-search-'));
  project = path.join(home, 'project');
  fs.mkdirSync(project);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  put('known_marketplaces.json', {
    studio: { installLocation: path.join(home, '.claude/plugins/marketplaces/studio'), lastUpdated: '2026-11-09T00:00:00Z' },
    community: { installLocation: path.join(home, '.claude/plugins/marketplaces/community') },
  });
  put('marketplaces/studio/.claude-plugin/marketplace.json', fixture('studio'));
  put('marketplaces/community/.claude-plugin/marketplace.json', fixture('community'));
  put('plugin-directory-cache-v2.json', fixture('directory'));
  put('install-counts-cache.json', fixture('counts'));
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
describe('provider plugin search (#4084)', () => {
  it('covers every configured marketplace and directory-only listings with explicit signals', async () => {
    const before = snapshot(home);
    const result = await run('UI/UX design', ['--json']);
    expect(result.status.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.marketplaces.map((m: { name: string }) => m.name)).toEqual(['community', 'studio']);
    expect(parsed.results.map((r: { id: string }) => r.id)).toEqual([
      'ux-suite@studio', 'directory-only@partners', 'layout-kit@studio', 'ux-suite@community',
    ]);
    expect(parsed.results[0]).toMatchObject({
      installs: { value: 120, asOf: '2026-11-10T00:00:00.000Z' },
      review: { value: 'anthropic', asOf: '2026-10-01T00:00:00.000Z' },
      installSkill: 'install-plugin',
    });
    expect(parsed.results[1].installs).toEqual({ value: null, asOf: null });
    expect(parsed.results[3].installs.value).toBe(0);
    expect(parsed.results[3].review.value).toBe('none');
    expect(parsed.warnings.join(' ')).toMatch(/stale.*plugin-directory-cache-v2/i);
    expect(snapshot(home)).toEqual(before);
    const { searchSkills } = await import('../../../src/skills/registry.js');
    const { searchCatalogs } = await import('../../../src/marketplace/exchange.js');
    expect(searchSkills).not.toHaveBeenCalled(); expect(searchCatalogs).not.toHaveBeenCalled();
  });
  it.each(['accessibility', 'design', 'prototyping', 'ux-suite'])('matches metadata: %s', async query => {
    expect(JSON.parse((await run(query, ['--json'])).output).results.length).toBeGreaterThan(0);
  });
  it('prints a table, missing markers, per-signal dates and install-skill link', async () => {
    const result = await run('UI/UX design');
    expect(result.output).toMatch(/Installs.*Review.*as.of/i);
    expect(result.output).toContain('unknown');
    expect(result.output).toContain('UI/UX design and development agents');
    expect(result.output).toContain('2026-10-01');
    expect(result.output).toContain('aiwg show skill install-plugin');
    expect(result.warnings).toMatch(/stale/i);
  });
  it('allows a configurable freshness age and rejects invalid ages', async () => {
    const fresh = JSON.parse((await run('design', ['--json', '--max-age-days', '90'])).output);
    expect(fresh.warnings.join(' ')).not.toMatch(/stale/i);
    for (const age of ['-1', 'NaN', '']) {
      expect((await run('design', ['--max-age-days', age])).status.exitCode).toBe(1);
    }
  });
  it('reports malformed and unavailable files while searching healthy marketplaces', async () => {
    put('marketplaces/community/.claude-plugin/marketplace.json', '{broken');
    put('install-counts-cache.json', { counts: { 'ux-suite@studio': { unique_installs: -5 } } });
    const parsed = JSON.parse((await run('design', ['--json'])).output);
    expect(parsed.results.find((r: { id: string }) => r.id === 'ux-suite@studio').installs.value).toBeNull();
    expect(parsed.warnings.join(' ')).toMatch(/community/);
  });
  it('explicitly defers Codex marketplace manifests without pretending to search them', async () => {
    const parsed = JSON.parse((await run('design', ['--provider', 'codex', '--json'])).output);
    expect(parsed.results).toEqual([]);
    expect(parsed.warnings.join(' ')).toMatch(/codex.*deferred/i);
  });
  it('reads the observed v2 listings format, correlating repository and entry names without guessing a marketplace', async () => {
    put('known_marketplaces.json', {
      studio: { installLocation: path.join(home, '.claude/plugins/marketplaces/studio'), source: { source: 'github', repo: 'example/studio' } },
      community: { installLocation: path.join(home, '.claude/plugins/marketplaces/community'), source: { source: 'github', repo: 'example/community' } },
    });
    put('plugin-directory-cache-v2.json', fixture('directory-v2'));
    put('install-counts-cache.json', { fetchedAt: '2026-11-10T00:00:00Z', counts: [{ plugin: 'ux-suite@studio', unique_installs: 120 }] });
    const parsed = JSON.parse((await run('UI/UX design', ['--json'])).output);
    expect(parsed.results.find((r: { id: string }) => r.id === 'ux-suite@studio')).toMatchObject({
      review: { value: 'anthropic' }, installs: { value: 120 }, description: 'UI/UX design implementation',
    });
    expect(parsed.results.find((r: { id: string }) => r.id === 'ux-suite@community').review.value).toBeNull();
    expect(parsed.results.find((r: { id: string }) => r.id === 'directory:plugin_independent')).toMatchObject({
      name: 'independent', marketplace: null, repository: 'github.com/example/independent', review: { value: 'partner' }, installs: { value: null },
    });
  });
  it('retains distinct directory IDs when uncatalogued listings share a repository and entry name', async () => {
    const directory = JSON.parse(fixture('directory-v2'));
    const duplicate = { ...directory.listings[1], id: 'plugin_independent_alternate' };
    directory.listings.push(duplicate);
    directory.entryNames[duplicate.id] = 'independent';
    put('plugin-directory-cache-v2.json', directory);
    const parsed = JSON.parse((await run('interfaces', ['--json'])).output);
    expect(parsed.results.map((r: { id: string }) => r.id)).toEqual([
      'directory:plugin_independent', 'directory:plugin_independent_alternate',
    ]);
  });
  it('does not correlate review tiers solely by name or install unknown directory listings', async () => {
    put('plugin-directory-cache-v2.json', fixture('directory-v2'));
    const parsed = JSON.parse((await run('UI/UX design', ['--json'])).output);
    const directory = parsed.results.find((r: { id: string }) => r.id === 'directory:plugin_studio');
    expect(directory).toMatchObject({ marketplace: null, review: { value: 'anthropic' }, installs: { value: null } });
    expect(parsed.results.find((r: { id: string }) => r.id === 'ux-suite@studio').review.value).toBeNull();
  });
  it('warns for unknown and future cache dates and handles absent caches', async () => {
    put('install-counts-cache.json', { fetchedAt: '2099-01-01T00:00:00Z', counts: [] });
    put('plugin-directory-cache-v2.json', { listings: [] });
    let parsed = JSON.parse((await run('design', ['--json'])).output);
    expect(parsed.warnings.join(' ')).toMatch(/future/);
    expect(parsed.warnings.join(' ')).toMatch(/date unknown/i);
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    parsed = JSON.parse((await run('design', ['--json'])).output);
    expect(parsed.results).toEqual([]);
    expect(parsed.warnings.join(' ')).toMatch(/nothing was fetched/);
  });
  it('supports configured checkouts outside the default marketplaces directory', async () => {
    const location = path.join(home, 'separate-checkout');
    fs.mkdirSync(path.join(location, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(location, '.claude-plugin/marketplace.json'), fixture('studio'));
    put('known_marketplaces.json', { outside: { installLocation: location } });
    const parsed = JSON.parse((await run('accessibility', ['--json'])).output);
    expect(parsed.results[0].id).toBe('ux-suite@outside');
  });
  it('rejects invalid providers and incompatible mutation flags', async () => {
    for (const flags of [['--provider', 'unknown'], ['--refresh'], ['--source', 'clawhub']]) {
      expect((await run('design', flags)).status.exitCode).toBe(1);
    }
  });
  it.each(['marketplace', 'market'])('keeps the built %s CLI offline and read-only from bootstrap through output', command => {
    vi.useRealTimers();
    const preload = path.join(home, 'deny-effects.cjs');
    fs.writeFileSync(preload, `
const fs = require('node:fs');
const {syncBuiltinESMExports} = require('node:module');
const deny = () => { process.stderr.write('FORBIDDEN EFFECT\\n'); throw new Error('offline read-only search'); };
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'unlinkSync']) fs[name] = deny;
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'unlink']) fs.promises[name] = deny;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) require('node:child_process')[name] = deny;
for (const name of ['node:http', 'node:https']) { require(name).request = deny; require(name).get = deny; }
require('node:net').connect = deny; require('node:net').createConnection = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
`);
    const before = snapshot(home);
    const result = spawnSync(process.execPath, ['--require', preload, path.resolve('bin/aiwg.mjs'), command, 'search', 'UI/UX', 'design', '--plugins', '--json'], {
      cwd: project, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, 'data'),
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
        XDG_STATE_HOME: path.join(home, 'state'), AIWG_CONFIG: path.join(home, '.aiwg'),
        AIWG_ROOT: path.resolve('.'), AIWG_CLI_DRY_RUN: '', NO_UPDATE_NOTIFIER: '', CI: '',
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).not.toContain('FORBIDDEN EFFECT');
    expect(JSON.parse(result.stdout).results[0].id).toBe('ux-suite@studio');
    expect(snapshot(home)).toEqual(before);
  });
  it('discovers marketplace plugin search first, ahead of installation and status', async () => {
    const runtime = path.join(home, 'runtime');
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'package.json'), '{"name":"aiwg"}');
    for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
      fs.mkdirSync(path.join(runtime, 'agentic/code', kind), { recursive: true });
    }
    const source = path.resolve('agentic/code/addons/aiwg-utils/skills');
    for (const skill of ['install-plugin', 'plugin-status', 'plugin-search']) {
      const file = path.join(source, skill, 'SKILL.md');
      if (fs.existsSync(file)) {
        const destination = path.join(runtime, 'agentic/code/addons/aiwg-utils/skills', skill);
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(file, path.join(destination, 'SKILL.md'));
      }
    }
    vi.stubEnv('AIWG_ROOT', runtime);
    vi.stubEnv('XDG_DATA_HOME', path.join(home, 'xdg'));
    vi.useRealTimers();
    const captured: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => captured.push(args.join(' ')));
    await buildIndex(runtime, { graph: 'framework', quiet: true });
    captured.length = 0;
    await discoverCapability(project, { phrase: 'search marketplaces for plugins', graph: 'framework', json: true, backend: 'local', limit: 3 });
    expect(JSON.parse(captured.join('\n')).results[0].name).toBe('plugin-search');
  });

});
