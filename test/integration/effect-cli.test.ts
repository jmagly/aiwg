/**
 * `aiwg effect` through the real entry point (bin/aiwg.mjs), with a temporary
 * project, a temporary external artifact root and the test-only ledger key
 * (#2720). Requires `npm run build:cli`. Offline only.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = resolve('.');
const bin = resolve(repo, 'bin/aiwg.mjs');
const missingBuild = !existsSync(resolve(repo, 'dist/src/cli/handlers/effect.js'));
const seed = createHash('sha256').update('aiwg-effect-cli-integration-test-key').digest('hex');

let root = '';
let project = '';

function run(args: string[], cwd = project): { status: number | null; json: any; stdout: string } {
  const result = spawnSync(process.execPath, [bin, 'effect', ...args], {
    cwd, encoding: 'utf8', timeout: 60_000,
    env: {
      ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'home', '.config'),
      AIWG_LOG_DISABLE: '1', NO_UPDATE_NOTIFIER: '1', AIWG_NO_UPDATE_CHECK: '1', NO_COLOR: '1',
      VITEST: 'true', AIWG_EFFECT_LEDGER_TEST_KEY: seed, AIWG_ARTIFACTS_PATH: '',
    },
  });
  let json: any = null;
  try { json = JSON.parse(result.stdout); } catch { /* not JSON */ }
  return { status: result.status, json, stdout: result.stdout };
}

function makeProject(name: string, artifactRoot: string | null): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.aiwg'), { recursive: true });
  writeFileSync(join(dir, '.aiwg', 'aiwg.config'), JSON.stringify({
    version: '1', providers: ['claude'], installed: {}, scripts: {}, effects: { tenant: 'local', project: 'example/repo' },
  }));
  if (artifactRoot) writeFileSync(join(dir, '.aiwg-location'), `${artifactRoot}\n`);
  execFileSync('git', ['init', '-q', dir], { timeout: 20_000, stdio: 'ignore' });
  return dir;
}

describe.skipIf(missingBuild)('aiwg effect via bin/aiwg.mjs', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-effect-bin-'));
    mkdirSync(join(root, 'artifacts'));
    project = makeProject('project', join(root, 'artifacts'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('EFF-BIN-01 records, replays, looks up, checkpoints and verifies with the contract exit codes', () => {
    writeFileSync(join(project, 'notes.md'), 'notes\n');
    const digest = `sha256:${createHash('sha256').update('notes\n').digest('hex')}`;
    const identity = ['--kind', 'file.digest', '--target', `file:notes.md@${digest}`];
    const first = run(['record', ...identity, '--payload-digest', digest]);
    expect(first.status, first.stdout).toBe(0);
    expect(first.json).toMatchObject({ schema: 'aiwg.effect.record.v1', status: 'completed', idempotent: false });
    const again = run(['record', ...identity, '--payload-digest', digest]);
    expect(again.status).toBe(0);
    expect(again.json.idempotent).toBe(true);
    const conflict = run(['record', ...identity, '--payload-digest', `sha256:${'0'.repeat(64)}`]);
    expect(conflict.status).toBe(5);
    expect(run(['lookup', first.json.effectId]).status).toBe(0);
    expect(run(['lookup', '--kind', 'file.digest', '--target', `file:other.md@${digest}`]).status).toBe(3);
    const checkpoint = run(['checkpoint']);
    expect(checkpoint.status, checkpoint.stdout).toBe(0);
    expect(checkpoint.json.sink.sink).toBe('git-ref');
    const verify = run(['verify', '--format', 'text']);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toMatch(/^ledger intact/);
    expect(existsSync(join(root, 'artifacts', 'effects', 'delivery', 'keyring.json'))).toBe(true);
    expect(run(['bogus']).status).toBe(2);
  });

  it('EFF-BIN-02 fails closed with exit 7 when the external artifact root is missing', () => {
    const detached = makeProject('detached', join(root, 'missing-root'));
    const result = run(['record', '--kind', 'tracker.comment', '--target', 'gitea:example/repo#1', '--issue', '1', '--payload-digest', `sha256:${'1'.repeat(64)}`], detached);
    expect(result.status).toBe(7);
    expect(result.json.schema).toBe('aiwg.effect.error.v1');
    expect(existsSync(join(root, 'missing-root'))).toBe(false);
    expect(readdirSync(join(detached, '.aiwg'))).toEqual(['aiwg.config']);
  });

  it('EFF-BIN-03 --help prints the usage without executing', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('aiwg effect record');
  });
});
