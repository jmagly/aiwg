// Exercise replay decisions with real synthetic npm-shaped archives.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectTarball, comparePackage, evaluateReplay, replayExitCode, runReplay,
  isolatedEnv, packEnv, parsePackIdentity } from '../../../tools/release/reproducibility-replay.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture({ changed = 0, missing = false, archiveVariance = false, source } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reproducibility-test-')); roots.push(root);
  const runs = [];
  for (let index = 1; index <= 5; index++) {
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`file-${i}.json`,
      source && i === 0 ? source(index) : JSON.stringify({ value: i < changed && index === 5 ? `changed-${i}` : i })]));
    if (missing && index === 5) delete files['file-0.json'];
    const file = path.join(root, `run-${index}.tgz`);
    const result = spawnSync('python3', ['-I', '-S', '-c', `
import io, json, sys, tarfile
files = json.load(sys.stdin)
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    for name, text in files.items():
        data = text.encode()
        info = tarfile.TarInfo('package/' + name)
        info.size = len(data)
        info.mtime = int(sys.argv[2])
        archive.addfile(info, io.BytesIO(data))
`, file, String(archiveVariance ? index : 0)], { input: JSON.stringify(files), encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error(result.stderr);
    runs.push({ run: index, packages: { aiwg: inspectTarball(file) } });
  }
  return { root, runs, report: evaluateReplay(runs, ['aiwg']) };
}
describe('five-run release replay', () => {
  it('passes identical file contents at 100% and retains real tarball/file digests', () => {
    const { report, runs } = fixture();
    expect(report).toMatchObject({ pass: true, match_percentage: 100, identical_files: 20, total_files: 20 });
    expect(report.packages[0].differing_files).toEqual([]);
    expect(runs[0].packages.aiwg.tarball_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(runs[0].packages.aiwg.files['file-0.json'].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(replayExitCode(report)).toBe(0);
  });
  it('passes exactly 95% while reporting one differing file and its unknown source', () => {
    const { report } = fixture({ changed: 1 });
    expect(report).toMatchObject({ pass: true, match_percentage: 95, match_rate: 0.95,
      threshold: 0.95, threshold_percent: 95 });
    expect(report.packages[0]).toMatchObject({ match_rate: 0.95, threshold: 0.95, threshold_percent: 95 });
    expect(report.packages[0].differing_files).toEqual([expect.objectContaining({ file: 'file-0.json',
      sources: ['unclassified content variation (requires investigation)'], digests: expect.any(Array) })]);
  });
  it('fails below threshold with reasons and a non-zero process exit', () => {
    const { root, report, runs } = fixture({ changed: 5 });
    expect(report).toMatchObject({ pass: false, match_percentage: 75 });
    expect(report.reasons).toEqual(['aiwg: 75.0000% < 95%', 'Overall: 75.0000% < 95%']);
    const input = path.join(root, 'runs.json'); fs.writeFileSync(input, JSON.stringify(runs));
    const module = new URL('../../../tools/release/reproducibility-replay.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import fs from 'node:fs'; import {evaluateReplay,replayExitCode} from ${JSON.stringify(module)};
const report=evaluateReplay(JSON.parse(fs.readFileSync(process.argv[1])),['aiwg']);
console.error(report.reasons.join('\\n')); process.exitCode=replayExitCode(report);`, input],
    { encoding: 'utf8', timeout: 10000 });
    expect(child.status).toBe(1); expect(child.stderr).toContain('75.0000% < 95%');
  });
  it('requires every package to pass even when the weighted overall percentage passes', () => {
    const { runs } = fixture();
    const broken = { ...runs[4].packages.aiwg.files, 'file-0.json': { sha256: 'different' } };
    runs.forEach((run, index) => {
      run.packages.small = { ...run.packages.aiwg, files: { 'only.json': (index === 4 ? broken : run.packages.aiwg.files)['file-0.json'] } };
    });
    const report = evaluateReplay(runs, ['aiwg', 'small']);
    expect(report.match_percentage).toBeGreaterThan(95); expect(report.pass).toBe(false);
    expect(report.reasons).toEqual(['small: 0.0000% < 95%']);
  });
  it('counts missing members in the union and rejects missing packages or runs', () => {
    const { runs, report } = fixture({ missing: true });
    expect(report.match_percentage).toBe(95);
    expect(report.packages[0].differing_files[0].sources).toEqual(['file inventory (added or missing)']);
    expect(report.packages[0].differing_files[0].digests[4]).toBeNull();
    expect(() => evaluateReplay(runs, ['missing'])).toThrow('Missing package');
    expect(() => comparePackage('aiwg', [])).toThrow('Exactly five');
    expect(() => runReplay({ version: '2026.11.7', runs: 4 })).toThrow('fixed at 5');
    expect(() => runReplay({ version: '../../escape' })).toThrow('CalVer');
  });
  it.each([
    ['timestamps', index => JSON.stringify({ time: `2026-11-16T12:00:0${index}Z` })],
    ['generated build IDs', index => JSON.stringify({ buildId: `build-${index}` })],
    ['JSON ordering', index => index === 5 ? '{"a":1,"b":2}' : '{"b":2,"a":1}'],
    ['line ordering', index => index === 5 ? 'a\nb\n' : 'b\na\n'],
  ])('classifies %s by normalization without discounting the difference', (source, content) => {
    const { report } = fixture({ source: content });
    expect(report.match_percentage).toBe(95);
    expect(report.packages[0].differing_files[0].sources).toContain(source);
  });
  it('reports archive timestamps independently of the unchanged content match percentage', () => {
    const { report } = fixture({ archiveVariance: true });
    expect(report.packages[0]).toMatchObject({ pass: true, match_percentage: 100, tarball_identical: false });
    expect(report.packages[0].archive_sources).toContain('archive timestamps');
  });
  it('gives every run an independent empty HOME and npm cache', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reproducibility-env-')); roots.push(temp);
    const environments = Array.from({ length: 5 }, (_, index) => isolatedEnv(temp, path.join(temp, `run-${index + 1}`), index + 1));
    expect(new Set(environments.map(env => env.HOME)).size).toBe(5);
    expect(new Set(environments.map(env => env.npm_config_cache)).size).toBe(5);
    environments.forEach((env, index) => {
      expect(env.HOME).toBe(path.join(temp, `home-${index + 1}`));
      expect(env.npm_config_cache).toBe(path.join(temp, `npm-cache-${index + 1}`));
      expect(env.USERPROFILE).toBe(env.HOME);
      expect(env.npm_config_userconfig).toBe(path.join(env.HOME, '.npmrc'));
      expect(env.XDG_CACHE_HOME).toBe(path.join(env.HOME, '.cache'));
      expect(fs.readdirSync(env.HOME)).toEqual([]);
      expect(fs.readdirSync(env.npm_config_cache)).toEqual([]);
      fs.writeFileSync(path.join(env.npm_config_cache, 'warm'), 'previous run');
      fs.writeFileSync(path.join(env.HOME, 'state'), 'previous run');
    });
  });
  it('allows network only for Cockpit and keeps hermetic packs offline with Cockpit selected', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reproducibility-network-')); roots.push(temp);
    const env = isolatedEnv(temp, temp, 1);
    expect(env.npm_config_offline).toBe('true');
    for (const name of ['aiwg', '@aiwg/cli', '@aiwg/flue', '@aiwg/cockpit']) {
      const selected = packEnv(env, name);
      expect(selected.npm_config_offline).toBe(name === '@aiwg/cockpit' ? 'false' : 'true');
      expect(selected.npm_config_prefer_offline).toBe('true');
      expect(selected.HOME).toBe(env.HOME);
      expect(selected.npm_config_cache).toBe(env.npm_config_cache);
    }
    expect(env.npm_config_offline).toBe('true');
    expect(packEnv({ ...env, npm_config_offline: 'false' }, 'aiwg').npm_config_offline).toBe('true');
  });
  it('reads trailing npm pack JSON with or without lifecycle banners', () => {
    const info = { name: 'aiwg', version: '2026.11.7', filename: 'aiwg-2026.11.7.tgz' };
    for (const banner of ['', '> aiwg prepack\n> build indices\n']) {
      expect(parsePackIdentity(`${banner}${JSON.stringify([info], null, 2)}\n`, 'aiwg', '2026.11.7')).toEqual(info);
    }
    expect(() => parsePackIdentity(JSON.stringify([info]), '@aiwg/cli', info.version)).toThrow('Invalid packed identity');
  });
  it.each(['> aiwg prepack\n> build indices\n', '> prepack\n[broken]\n'])('rejects unreadable npm pack output: %s', text => {
    expect(() => parsePackIdentity(text, 'aiwg', '2026.11.7')).toThrow('pack identity unreadable for aiwg');
  });
  it.each(['', ' M package.json', '?? untracked.txt'])('requires a clean status before step 8b: %j', status => {
    const source = fs.readFileSync(new URL('../../../tools/release/cut-tag.sh', import.meta.url), 'utf8');
    const start = source.indexOf('if [ -n "$(git status --porcelain)" ]; then');
    const end = source.indexOf('\nfi', start) + '\nfi'.length;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeLessThan(source.indexOf('\nnpm run build:cli'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reproducibility-clean-')); roots.push(home);
    const child = spawnSync('bash', ['-c', `git() { printf '%s' "$TEST_STATUS"; }\n${source.slice(start, end)}`],
      { encoding: 'utf8', env: { ...process.env, HOME: home, TEST_STATUS: status }, timeout: 10000 });
    expect(child.status).toBe(status ? 1 : 0);
    if (status) expect(child.stderr).toContain('require a clean worktree');
  });
  it('runs the required all-package gate after the slow lane and before signing access', () => {
    const source = fs.readFileSync(new URL('../../../tools/release/cut-tag.sh', import.meta.url), 'utf8');
    const invocation = '\nnode tools/release/reproducibility-replay.mjs --version "$TAG_VERSION" --runs 5 --include cockpit';
    const gate = source.indexOf(invocation);
    expect(gate).toBeGreaterThan(source.indexOf('\nnode tools/ci/run-with-hang-report.mjs'));
    expect(gate).toBeLessThan(source.indexOf('\nif [ "$AIWG_RELEASE_SIGN_FROM_VAULT" = "1" ]'));
    expect(gate).toBeLessThan(source.indexOf('\ngit "${GIT_TAG_GPG_OPTS[@]}" tag -s'));
    expect(source).toContain('set -euo pipefail');
  });
});
