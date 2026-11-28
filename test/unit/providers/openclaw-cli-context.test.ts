// Exercise the built CLI so project resolution and repeat deployment stay covered.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../../..');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-openclaw-cli-'));
  roots.push(root);
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, OPENCLAW_PROFILE: 'default',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
    AIWG_ROOT: repo, AIWG_NO_UPDATE_CHECK: '1',
  };
  execFileSync('git', ['init', '--quiet', project], { env, timeout: 10_000 });
  const deploy = (extra: string[] = []) => execFileSync(process.execPath,
    [path.join(repo, 'bin/aiwg.mjs'), 'use', 'all', '--provider', 'openclaw', '--yes', ...extra],
    { cwd: project, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  return { home, project, deploy };
}

describe('built OpenClaw CLI startup context (#4264)', () => {
  it('updates project bridges on repeat deployment and retains the default workspace copies', () => {
    const { home, project, deploy } = fixture();
    deploy();
    // Emulate stale managed content without changing the packaged templates.
    for (const [file, current] of [['AGENTS.md', 'before any other tool call or answer'],
      ['SOUL.md', 'You are the **AIWG Steward**']] as const) {
      const target = path.join(project, file);
      if (fs.existsSync(target)) fs.writeFileSync(target,
        `# Operator ${file}\n${fs.readFileSync(target, 'utf8').replace(current, 'STALE AIWG CONTENT')}`);
    }
    deploy();
    for (const directory of [project, path.join(home, '.openclaw/workspace')]) {
      expect(fs.existsSync(path.join(directory, 'AGENTS.md')), directory).toBe(true);
      expect(fs.existsSync(path.join(directory, 'SOUL.md')), directory).toBe(true);
      const agents = fs.readFileSync(path.join(directory, 'AGENTS.md'), 'utf8');
      const soul = fs.readFileSync(path.join(directory, 'SOUL.md'), 'utf8');
      expect(agents.match(/AIWG:provider-bootstrap:start/g)).toHaveLength(1);
      expect(agents.match(/AIWG:rule-hook-openclaw:start/g)).toHaveLength(1);
      expect(soul.match(/<!-- AIWG Steward Identity -->/g)).toHaveLength(1);
      expect(agents).toContain('aiwg discover --stdin');
      expect(agents).toContain('before any other tool call or answer');
      expect(agents).not.toContain('STALE AIWG CONTENT');
      expect(soul).not.toContain('STALE AIWG CONTENT');
      if (directory === project) {
        expect(agents).toContain('# Operator AGENTS.md');
        expect(soul).toContain('# Operator SOUL.md');
      }
    }
  }, 300_000);

  it('keeps global startup context out of HOME itself', () => {
    const { home, deploy } = fixture();
    deploy(['--global']);
    for (const name of ['AGENTS.md', 'SOUL.md']) {
      expect(fs.existsSync(path.join(home, name)), name).toBe(false);
      expect(fs.existsSync(path.join(home, '.openclaw/workspace', name)), name).toBe(true);
    }
  }, 180_000);

  it('repairs an existing project whose startup bridges are missing', () => {
    const { home, project, deploy } = fixture();
    deploy();
    // Earlier releases installed the framework and home copies without these files.
    for (const name of ['AGENTS.md', 'SOUL.md']) fs.rmSync(path.join(project, name), { force: true });
    deploy();
    for (const directory of [project, path.join(home, '.openclaw/workspace')]) {
      const agents = fs.readFileSync(path.join(directory, 'AGENTS.md'), 'utf8');
      const soul = fs.readFileSync(path.join(directory, 'SOUL.md'), 'utf8');
      expect(agents.match(/AIWG:provider-bootstrap:start/g)).toHaveLength(1);
      expect(agents).toContain('aiwg discover --stdin');
      expect(soul.match(/<!-- AIWG Steward Identity -->/g)).toHaveLength(1);
    }
  }, 300_000);
});
