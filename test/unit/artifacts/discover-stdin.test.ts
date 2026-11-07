// Verify literal shell input and discover usage through the built CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const binary = fileURLToPath(new URL('../../../bin/aiwg.mjs', import.meta.url));
let root: string;
let project: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-discover-stdin-'));
  project = path.join(root, 'project');
  const skill = path.join(project, '.aiwg/skills/workspace-orbit/SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: workspace-orbit\ndescription: Coordinate workspace orbit\n---\n# Workspace orbit\n');
  const template = path.join(project, '.aiwg/templates/workspace-orbit-template.md');
  fs.mkdirSync(path.dirname(template), { recursive: true });
  fs.writeFileSync(template, '---\ntype: template\nname: workspace-orbit-template\ndescription: Workspace orbit template\n---\n# Workspace orbit template\n');
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    vi.stubEnv(key, path.join(root, key));
  }
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
    'AIWG_PROJECT_LOCAL_PATHS', 'AIWG_FRAMEWORK_INDEX_CACHE', 'AIWG_FRAMEWORK_INDEX_CACHE_SOURCE']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', path.join(root, 'runtime'));
  vi.stubEnv('AIWG_CONFIG', path.join(root, 'config'));
  vi.stubEnv('AIWG_INDEX_WORKERS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function invoke(args: string[], input = '') {
  return spawnSync(process.execPath, [binary, ...args], {
    cwd: project, input, encoding: 'utf8', timeout: 30_000,
  });
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

describe('discover --stdin (#3946)', () => {
  it.each(['local', 'fortemi-core'])('preserves literal shell syntax through a quoted heredoc (%s)', backend => {
    const backtickMarker = path.join(root, 'backtick-executed');
    const dollarMarker = path.join(root, 'dollar-executed');
    const phrase = 'workspace orbit `touch ' + backtickMarker + '` $(touch ' + dollarMarker + ') \'single\' "double"';
    const command = `${shellQuote(process.execPath)} ${shellQuote(binary)} discover --backend ${backend} --stdin --type skill --graph project --json --compact --limit 1 --resource-source local --offline`;
    const result = spawnSync('bash', ['-s'], {
      cwd: project, encoding: 'utf8', timeout: 30_000,
      input: `${command} <<'AIWG_REQUEST'\n \n${phrase}\n\t\nAIWG_REQUEST\n`,
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.query.phrase).toBe(phrase);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({ name: 'workspace-orbit', type: 'skill' });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(backtickMarker)).toBe(false);
    expect(fs.existsSync(dollarMarker)).toBe(false);
  });

  it('keeps template filters and JSON format flags working with stdin', () => {
    const result = invoke(['discover', '--stdin', '--type', 'template', '--format', 'json', '--pretty',
      '--graph', 'project', '--backend', 'local', '--limit', '1'], '  workspace orbit template\n');
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.query.phrase).toBe('workspace orbit template');
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({ name: 'workspace-orbit-template', type: 'template' });
  });

  it.each([['workspace orbit', '--stdin'], ['--stdin', '--type', 'skill', 'workspace orbit']].map(args => ({ args })))(
    'rejects positional text combined with stdin: $args', ({ args }) => {
      const result = invoke(['discover', ...args], 'another phrase');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--stdin cannot be combined with a positional search phrase');
      expect(result.stdout).toBe('');
    });

  it.each(['', ' \n\t '])('rejects empty stdin (%j)', input => {
    const result = invoke(['discover', '--stdin', '--json'], input);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--stdin requires a non-empty search phrase');
    expect(result.stdout).toBe('');
  });

  it.each([['discover', '--help'], ['discover', '-h'], ['index', 'discover', '--help']].map(args => ({ args })))(
    'prints discover help without reading stdin: $args', ({ args }) => {
      const result = invoke([...args, '--stdin']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage: aiwg discover [<phrase> | --stdin]');
      for (const flag of ['--stdin', '--type', '--json', '--limit', '--graph', '--backend', '--help']) {
        expect(result.stdout).toContain(flag);
      }
      expect(result.stdout).toContain("\naiwg discover --stdin <<'AIWG_REQUEST'\n<the request, verbatim>\nAIWG_REQUEST");
    });
});
