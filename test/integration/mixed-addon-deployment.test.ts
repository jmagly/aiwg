import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { recordManagedCopy } from '../helpers/managed-copy-fixture.js';
import os from 'node:os';
import path from 'node:path';
import { UseHandler } from '../../src/cli/handlers/use.js';

let projectDir: string;

function context(addon: string) {
  return {
    args: [addon, '--target', projectDir, '--provider', 'claude'],
    rawArgs: ['use', addon, '--target', projectDir, '--provider', 'claude'],
    cwd: projectDir,
    frameworkRoot: path.resolve(__dirname, '../..'),
  };
}

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'aiwg-mixed-addon-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('mixed agent and skill addon deployment', () => {
  it.each(['local-safety-addon', 'writing-quality'])('%s preserves every deployed kernel rule and skill (#4087)', addon => {
    const repo = path.resolve(__dirname, '../..');
    const home = path.join(projectDir, 'home');
    const bundle = path.join(projectDir, '.aiwg/addons/local-safety-addon');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(bundle, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({
      id: 'local-safety-addon', type: 'addon', name: 'Local safety addon', version: '1.0.0',
      manifestVersion: '1', description: 'Synthetic scoped deployment fixture',
      platforms: { claude: 'full' }, keywords: ['test'],
      deployment: { pathTemplate: '.aiwg/addons/local-safety-addon' },
      addonConfig: { entry: { rules: 'rules/' } },
    }));
    fs.writeFileSync(path.join(bundle, 'rules/addon-policy.md'),
      '---\nname: addon-policy\nactivation: kernel\nenforcement: critical\n---\n# Addon policy\n');
    fs.writeFileSync(path.join(bundle, 'rules/addon-keep.md'),
      '---\nname: addon-keep\nactivation: kernel\n---\n# Retained addon policy\n');
    fs.writeFileSync(path.join(projectDir, '.aiwg/aiwg.config'), JSON.stringify({ providers: ['claude'] }));
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [path.join(repo, 'bin/aiwg.mjs'), ...args], {
        cwd: projectDir, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, AIWG_ROOT: repo,
          XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
          XDG_CACHE_HOME: path.join(home, '.cache'), CI: '1', NO_UPDATE_NOTIFIER: '1' },
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout + result.stderr;
    };
    cli('use', 'all', '--provider', 'claude', '--no-project-local', '--quiet');
    const rules = path.join(projectDir, '.claude/rules');
    // Simulate the deployed 2026.11.1 kernel contracts, absent from today's selection.
    for (const name of ['sys-hardware-safety', 'sys-interactive-gate']) {
      const file = path.join(rules, `${name}.md`);
      fs.writeFileSync(file, `<!-- aiwg:managed v2026.11.1 bundled -->\n---\nname: ${name}\nactivation: kernel\nenforcement: critical\n---\n# ${name}\n`);
      recordManagedCopy(file);
    }
    const agents = path.join(projectDir, '.claude/agents');
    fs.mkdirSync(agents, { recursive: true });
    for (const name of ['selected-retired', 'foreign-retired']) {
      const file = path.join(agents, `${name}.md`);
      fs.writeFileSync(file, '<!-- aiwg:managed v2026.11.1 bundled -->\n# Retired\n');
      recordManagedCopy(file);
    }
    const agentManifest = path.join(agents, '.aiwg-manifest.json');
    const agentReceipt = JSON.parse(fs.readFileSync(agentManifest, 'utf8'));
    agentReceipt.managed['selected-retired.md'].owners = [addon];
    agentReceipt.managed['foreign-retired.md'].owners = ['other-addon'];
    fs.writeFileSync(agentManifest, JSON.stringify(agentReceipt));
    const snapshot = (root: string): Map<string, Buffer> => new Map(fs.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name !== '.aiwg-manifest.json' && !/^RULES-(?:INDEX|ONDEMAND)\./.test(entry.name))
      .map(entry => [path.join(entry.parentPath, entry.name), fs.readFileSync(path.join(entry.parentPath, entry.name))]));
    const before = new Map([...snapshot(rules), ...snapshot(path.join(projectDir, '.claude/skills')),
      [path.join(projectDir, '.claude/settings.json'), fs.readFileSync(path.join(projectDir, '.claude/settings.json'))] as [string, Buffer]]);
    const receipts = new Map(fs.readdirSync(path.join(projectDir, '.claude'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name === '.aiwg-manifest.json' && /[/\\](?:rules|skills)(?:[/\\]|$)/.test(entry.parentPath))
      .map(entry => {
        const file = path.join(entry.parentPath, entry.name);
        return [file, JSON.parse(fs.readFileSync(file, 'utf8'))];
      }));
    const preview = cli('use', addon, '--provider', 'claude', '--dry-run');
    expect(preview).not.toMatch(/Would (?:remove|write).*sys-(?:hardware-safety|interactive-gate)/);
    expect(preview).not.toContain('Would write ' + path.join(projectDir, '.claude/settings.json'));
    for (const file of before.keys()) expect(preview).not.toContain(`Would write ${file}`);
    expect(preview).toContain(`Would remove ${path.join(agents, 'selected-retired.md')}`);
    expect(preview).not.toContain(`Would remove ${path.join(agents, 'foreign-retired.md')}`);
    cli('use', addon, '--provider', 'claude', '--quiet');
    for (const [file, bytes] of before) {
      expect(fs.existsSync(file), file).toBe(true);
      expect(fs.readFileSync(file), file).toEqual(bytes);
    }
    for (const [file, receipt] of receipts) {
      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [name, record] of Object.entries(receipt.managed || {})) {
        if (!/^RULES-(?:INDEX|ONDEMAND)\./.test(name)) expect(after.managed[name], `${file}/${name}`).toEqual(record);
      }
    }
    expect(fs.existsSync(path.join(agents, 'selected-retired.md'))).toBe(false);
    expect(fs.existsSync(path.join(agents, 'foreign-retired.md'))).toBe(true);
    const index = fs.readFileSync(path.join(rules, 'RULES-INDEX.md'), 'utf8');
    for (const name of ['sys-hardware-safety', 'sys-interactive-gate']) expect(index).toContain(name);
    if (addon === 'local-safety-addon') {
      expect(fs.existsSync(path.join(rules, 'addon-policy.md'))).toBe(true);
      fs.rmSync(path.join(bundle, 'rules/addon-policy.md'));
      const reason = `remove ${path.join(rules, 'addon-policy.md')} (critical rule retired because`;
      expect(cli('use', addon, '--provider', 'claude', '--dry-run')).toContain(reason);
      const applied = cli('use', addon, '--provider', 'claude', '--quiet');
      expect(applied).toContain(`Removing ${path.join(rules, 'addon-policy.md')} (critical rule retired because`);
      expect(fs.existsSync(path.join(rules, 'addon-policy.md'))).toBe(false);
    }
  }, 240_000);

  it('copies complete skill trees and persists installed records', async () => {
    const handler = new UseHandler();

    const writing = await handler.execute(context('writing-quality'));
    expect(writing.exitCode, writing.message).toBe(0);
    expect(await readFile(
      path.join(projectDir, '.claude/.aiwg/skills/ai-pattern-detection/scripts/pattern_scanner.py'),
      'utf8',
    )).toContain('pattern');

    const sampling = await handler.execute(context('verbalized-sampling'));
    expect(sampling.exitCode, sampling.message).toBe(0);
    expect(await readFile(
      path.join(projectDir, '.claude/agents/verbalized-content-diversifier.md'), 'utf8',
    )).toContain('Verbalized Sampling');
    expect(await readFile(
      path.join(projectDir, '.claude/.aiwg/skills/diversity-tuning/SKILL.md'),
      'utf8',
    )).toContain('name: diversity-tuning');

    const config = JSON.parse(
      await readFile(path.join(projectDir, '.aiwg/aiwg.config'), 'utf8'),
    );
    expect(config.installed['writing-quality'].deployedTo.claude).toMatchObject({
      agents: 3,
      skills: 1,
    });
    expect(config.installed['verbalized-sampling'].deployedTo.claude).toMatchObject({
      agents: 1,
      skills: 1,
      rules: 1,
    });
  }, 180_000);
});
