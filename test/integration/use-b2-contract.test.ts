import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-b2-contract-'));
const home = path.join(scratch, 'home');
mkdirSync(home);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function run(name: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const cwd = path.join(scratch, name);
  mkdirSync(cwd, { recursive: true });
  const stdout = path.join(scratch, `${name}.stdout`);
  const stderr = path.join(scratch, `${name}.stderr`);
  const outFd = openSync(stdout, 'w');
  const errFd = openSync(stderr, 'w');
  const child = spawnSync(process.execPath, [path.join(root, 'bin/aiwg.mjs'), 'use', ...args], {
    cwd, encoding: 'utf8', timeout: 240_000, stdio: ['ignore', outFd, errFd],
    env: { ...process.env, HOME: home, USERPROFILE: home, AIWG_ROOT: root,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local/share'), NO_UPDATE_NOTIFIER: '1', ...env },
  });
  closeSync(outFd);
  closeSync(errFd);
  expect(child.error).toBeUndefined();
  return { code: child.status, output: readFileSync(stdout, 'utf8') + readFileSync(stderr, 'utf8'), cwd };
}

describe('B2 use CLI contract', () => {
  it.each([
    ['claude,muse', false, 'project'],
    ['claude,muse', true, 'user'],
    ['claude,pi', false, 'project'],
    ['claude,pi', true, 'project'],
    // Hermes discovers skills only under HERMES_HOME, so it deploys at user scope (#3461).
    ['claude,hermes', false, 'user'],
    ['copilot,factory,opencode,windsurf,antigravity,muse,omp,grok-build', false, 'project'],
    ['copilot,factory,opencode,windsurf,antigravity,muse,omp,grok-build', true, 'project'],
  ] as const)('projects rules once per provider for multi-source use all (%s, dry-run: %s, %s)', (selectedProviders, dryRun, scope) => {
    const name = `projection-${selectedProviders}-${dryRun}`;
    const trace = path.join(scratch, `${name}.jsonl`);
    const temporary = path.join(scratch, `${name}-tmp`);
    mkdirSync(temporary);
    const loader = path.join(root, 'test/fixtures/deployment/rule-projection-loader.mjs');
    const result = run(name, [
      'all', '--providers', selectedProviders, '--scope', scope, '--no-context-files', '--no-project-local',
      ...(dryRun ? ['--dry-run'] : []),
    ], {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --experimental-loader=${loader}`,
      AIWG_TEST_RULE_PROJECTION_TRACE: trace,
      TMPDIR: temporary,
    });
    expect(result.code, result.output).toBe(0);
    const providers = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const canonicalProviders = selectedProviders.split(',').map(provider => provider === 'windsurf' ? 'devin' : provider);
    expect(providers.sort()).toEqual(canonicalProviders.sort());
    expect(readdirSync(temporary)).toEqual([]);
    if (dryRun) expect(readdirSync(result.cwd)).toEqual([]);
  }, 240_000);

  it.each(['--bogus-flag-xyz', '--dev', '--force=true', '--aiwg-provider-main-prepared', '--defer-rule-projection'])('rejects %s before setup can write', (flag) => {
    const result = run(flag.slice(2), ['all', '--provider', 'claude', flag]);
    expect(result.code).toBe(2);
    expect(result.output).toContain(`Unknown option '${flag}'`);
    expect(result.output).toContain('aiwg use --help');
    expect(readdirSync(result.cwd)).toEqual([]);
  });

  it('prints a single kernel deployment plan without repeated extension projections (#3464)', () => {
    const result = run('preview', ['all', '--provider', 'claude', '--no-context-files', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.output.match(/Deployment preview:/g)).toHaveLength(1);
    const actions = result.output.split('\n').filter(line => line.startsWith('[dry-run] Would '));
    expect(actions.length).toBeGreaterThan(30);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions.filter(line => line.endsWith('/rules/core-anti-laziness.md'))).toHaveLength(1);
    expect(result.output).not.toContain('Deployed:');
    expect(result.output).not.toContain('=== AIWG Agent Deployment ===');
    expect(readdirSync(result.cwd)).toEqual([]);
  }, 240_000);

  it('accepts the SDLC directory alias and normalizes the plan to sdlc (#3468)', () => {
    const result = run('alias', ['sdlc-complete', '--provider', 'claude', '--no-context-files', '--no-hooks', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('Deployment preview: sdlc for claude');
    expect(result.output).not.toContain('Unknown target');
    expect(result.output).toContain('[dry-run] Would write');
  }, 240_000);

  it('reports pi agent files separately from kernel skill directories (#3465)', () => {
    const result = run('pi', ['all', '--provider', 'pi', '--force', '--no-context-files']);
    expect(result.code).toBe(0);
    const entries = readdirSync(path.join(result.cwd, '.agents/skills'), { withFileTypes: true });
    expect(entries.filter(entry => entry.isDirectory()).length).toBeGreaterThan(0);
    const agentFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.md'));
    expect(agentFiles).toHaveLength(0);
    expect(result.output).toMatch(/Agents 0\s+·\s+Commands/);
    expect(result.output).toMatch(/Skills [1-9]\d*/);
  }, 240_000);

  it('keeps help, errors and the skill aligned on all and automatic source detection (#3469, #3470)', () => {
    const help = run('help', ['--help']);
    const error = run('error', ['unknown-target', '--provider', 'claude', '--dry-run']);
    const skill = readFileSync(path.join(root, 'agentic/code/addons/aiwg-utils/skills/use/SKILL.md'), 'utf8');
    for (const text of [help.output, error.output, skill]) {
      expect(text).toContain('kernel and core rules');
      expect(text).not.toContain('every framework + every addon + every extension');
    }
    expect(skill).not.toContain('--dev');
    expect(help.output).not.toContain('--dev');
    expect(help.output).toContain('Source installs are detected automatically');
    expect(skill).toContain('Source checkouts are detected automatically');
    expect(help.output).toMatch(/\n  sdlc \| research/);
  }, 240_000);
});
