// OpenClaw --cwd sessions need the same managed startup context as default sessions.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../../..');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-openclaw-project-'));
  roots.push(root);
  const target = path.join(root, 'project'), home = path.join(root, 'home');
  const source = path.join(root, 'source');
  fs.mkdirSync(target);
  fs.mkdirSync(home);
  fs.cpSync(path.join(repo, 'test/fixtures/rule-delivery'), source, { recursive: true });
  for (const name of ['fixture-bound', 'fixture-paths', 'fixture-summary']) {
    fs.rmSync(path.join(source, 'rules', `${name}.md`));
  }
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  const templates = path.join(source, 'agentic/code/frameworks/sdlc-complete/templates/openclaw');
  fs.mkdirSync(templates, { recursive: true });
  fs.writeFileSync(path.join(templates, 'AGENTS.md.aiwg-template'), '<!-- AIWG SDLC Framework Integration -->\nFixture bridge.\n');
  fs.writeFileSync(path.join(templates, 'SOUL.md.aiwg-template'), '<!-- AIWG Steward Identity -->\nUse aiwg discover.\n');
  const workspace = path.join(home, '.openclaw/workspace');
  const read = (directory: string, file: string) => fs.readFileSync(path.join(directory, file), 'utf8');
  const deploy = (extra = {}) => execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { deploy } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers/openclaw.mjs'))});
    await deploy(${JSON.stringify({ srcRoot: source, target, mode: 'all', kernelOnly: true,
      skillsOnly: true, deploySkills: true, quiet: true, ...extra })});
  `], { cwd: target, encoding: 'utf8', timeout: 60_000, env: {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, OPENCLAW_PROFILE: 'default',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    AIWG_ROOT: source, AIWG_RULES_INLINE_BUDGET_TOKENS: '0',
  } });
  return { target, workspace, templates, read, deploy };
}

describe('OpenClaw project startup context (#4264)', () => {
  it('emits discover-first agents and steward identity in the project and default workspace', () => {
    const f = fixture();
    f.deploy();
    for (const directory of [f.target, f.workspace]) {
      expect(fs.existsSync(path.join(directory, 'AGENTS.md')), directory).toBe(true);
      const agents = f.read(directory, 'AGENTS.md');
      expect(agents).toContain('WORKSPACE.md');
      expect(agents).toContain('AIWG.md');
      expect(agents).toContain('aiwg discover --stdin');
      expect(agents).toContain('before any other tool call or answer');
      expect(agents).toContain('openclaw: Before every task');
      expect(f.read(directory, 'SOUL.md')).toContain('Use aiwg discover.');
    }
  });

  it('updates project managed sections in place and preserves operator content', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.target, 'AGENTS.md'), '# Operator rules\n');
    fs.writeFileSync(path.join(f.target, 'SOUL.md'), '# Operator identity\n');
    f.deploy();
    expect(f.read(f.target, 'AGENTS.md')).toContain('AIWG:rule-hook-openclaw:start');
    expect(f.read(f.target, 'SOUL.md')).toContain('Use aiwg discover.');
    const original = f.read(f.target, 'AGENTS.md');
    // Simulate an older bootstrap and a newer identity template.
    fs.writeFileSync(path.join(f.target, 'AGENTS.md'), original.replace('On a new task, first run discovery for the request', 'Old discovery instruction'));
    fs.writeFileSync(path.join(f.templates, 'SOUL.md.aiwg-template'), '<!-- AIWG Steward Identity -->\nUpdated: use aiwg discover.\n');
    f.deploy();
    const agents = f.read(f.target, 'AGENTS.md'), soul = f.read(f.target, 'SOUL.md');
    expect(agents).toContain('# Operator rules');
    expect(agents).not.toContain('Old discovery instruction');
    expect(agents.match(/AIWG:provider-bootstrap:start/g)).toHaveLength(1);
    expect(agents.match(/AIWG:rule-hook-openclaw:start/g)).toHaveLength(1);
    expect(soul).toContain('# Operator identity');
    expect(soul).toContain('Updated: use aiwg discover.');
    expect(soul.match(/<!-- AIWG Steward Identity -->/g)).toHaveLength(1);
    f.deploy();
    expect(f.read(f.target, 'AGENTS.md')).toBe(agents);
    expect(f.read(f.target, 'SOUL.md')).toBe(soul);
  });

  it('does not create project or home startup context during dry-run', () => {
    const f = fixture();
    f.deploy({ dryRun: true });
    for (const directory of [f.target, f.workspace]) {
      expect(fs.existsSync(path.join(directory, 'AGENTS.md'))).toBe(false);
      expect(fs.existsSync(path.join(directory, 'SOUL.md'))).toBe(false);
    }
  });

  it('preserves project startup files when context files are disabled', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.target, 'AGENTS.md'), '# Operator rules\n');
    fs.writeFileSync(path.join(f.target, 'SOUL.md'), '# Operator identity\n');
    f.deploy({ contextFiles: false });
    expect(f.read(f.target, 'AGENTS.md')).toBe('# Operator rules\n');
    expect(f.read(f.target, 'SOUL.md')).toBe('# Operator identity\n');
  });
});
