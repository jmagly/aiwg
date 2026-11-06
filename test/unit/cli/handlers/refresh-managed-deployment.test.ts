// Regression fixtures for hook/rule drift, including the compiled read-only CLI path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkManagedDeployment } from '../../../../src/cli/handlers/refresh-managed-deployment.js';
import { installAiwgHooks, managedClaudeHooks } from '../../../../src/extensions/claude-hooks-installer.js';
import { AIWG_MANAGED_HOOKS } from '../../../../src/extensions/muse-managed-hooks.js';
import { refreshHandler } from '../../../../src/cli/handlers/refresh.js';
import * as ui from '../../../../src/cli/ui.js';

const frameworkRoot = path.resolve(import.meta.dirname, '../../../..');
const version = JSON.parse(fs.readFileSync(path.join(frameworkRoot, 'package.json'), 'utf8')).version;
const scripts = fs.readdirSync(path.join(frameworkRoot, 'agentic/code/addons/aiwg-hooks/hooks'));
let projectRoot: string;

function write(file: string, content: string | object) {
  const target = path.join(projectRoot, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function currentFixture(provider: string) {
  const manifestHash = 'sha256:' + createHash('sha256').update(fs.readFileSync(
    path.join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/manifest.json'))).digest('hex');
  write('.aiwg/aiwg.config', { version: '1', providers: [provider], scripts: {}, installed: {
    sdlc: { version, manifestHash, deployedTo: { [provider]: {} } },
  } });
  const hooks: Record<string, object[]> = {};
  if (provider === 'claude') {
    for (const { event, hookId, command } of managedClaudeHooks(scripts)) {
      (hooks[event] ??= []).push({ hooks: [{ type: 'command', command, _aiwg_id: hookId, _aiwg_managed: true }] });
    }
    write('.claude/settings.json', { hooks, operatorSetting: true });
  } else {
    for (const hook of AIWG_MANAGED_HOOKS) (hooks[hook.event] ??= []).push(hook.group);
    write('.muse/hooks.json', { hooks });
    write('.muse/.aiwg-hooks.json', { version: 1, hooks: AIWG_MANAGED_HOOKS });
  }
  write(`.${provider}/rules/artifact-output-policy.md`, `<!-- aiwg:managed v${version} bundled -->\n# Current\n`);
}

function hookFile(provider: string) {
  return provider === 'claude' ? '.claude/settings.json' : '.muse/hooks.json';
}

function changeHooks(provider: string, change: (doc: any) => void) {
  const file = hookFile(provider);
  const doc = JSON.parse(fs.readFileSync(path.join(projectRoot, file), 'utf8'));
  change(doc);
  write(file, doc);
}

function snapshot(directory = projectRoot): Record<string, string> {
  return Object.fromEntries([[path.relative(projectRoot, directory) || '.', `directory:${fs.statSync(directory).mtimeMs}`],
    ...fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)) :
      [[path.relative(projectRoot, file), `${fs.statSync(file).mtimeMs}:${fs.readFileSync(file).toString('base64')}`]];
    })]);
}

function check(provider: string, quiet = true) {
  return checkManagedDeployment({ projectRoot, frameworkRoot, provider, quiet });
}

function cli(provider: string, quiet = false) {
  return execFileSync(process.execPath, [path.join(frameworkRoot, 'bin/aiwg.mjs'), 'refresh', '--dry-run',
    '--provider', provider, ...(quiet ? ['--quiet'] : [])], {
    cwd: projectRoot, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, AIWG_CONFIG: path.join(projectRoot, 'runtime-config'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
}

beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-managed-drift-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe.each(['claude', 'muse'])('%s managed deployment drift', provider => {
  it('names prompt discovery when its registration is missing despite current manifest state', async () => {
    currentFixture(provider);
    changeHooks(provider, doc => { delete doc.hooks.UserPromptSubmit; });
    const before = snapshot();
    expect(await check(provider)).toEqual([expect.objectContaining({
      name: 'UserPromptSubmit → aiwg-prompt-discovery', reason: 'missing', file: hookFile(provider),
    })]);
    expect(snapshot()).toEqual(before);
  });

  it('reports an outdated managed hook command', async () => {
    currentFixture(provider);
    changeHooks(provider, doc => {
      doc.hooks.UserPromptSubmit[0].hooks[0].command = 'node obsolete-prompt-discovery.js';
      if (provider === 'muse') write('.muse/.aiwg-hooks.json', { version: 1, hooks: [{
        id: 'aiwg-prompt-discovery', event: 'UserPromptSubmit', group: doc.hooks.UserPromptSubmit[0],
      }] });
    });
    expect(await check(provider)).toEqual([expect.objectContaining({ name: 'UserPromptSubmit → aiwg-prompt-discovery', reason: 'outdated' })]);
  });

  it('reports an older managed rule by filename and version', async () => {
    currentFixture(provider);
    write(`.${provider}/rules/older-rule.md`, '---\n# aiwg:managed v2026.11.0 bundled\n---\n# Old\n');
    write(`.${provider}/rules/operator-rule.md`, '# Operator rule\n');
    write(`.${provider}/rules/local-rule.md`, '<!-- aiwg:managed v1.0.0 project-local -->\n');
    write(`.${provider}/rules/newer-rule.md`, '<!-- aiwg:managed v2099.1.0 bundled -->\n');
    const stale = await check(provider);
    expect(stale).toEqual([expect.objectContaining({ file: `.${provider}/rules/older-rule.md`, reason: 'outdated' })]);
    expect(stale[0].name).toContain('v2026.11.0');
  });

  it('accepts current registrations and managed rules alongside operator hooks', async () => {
    currentFixture(provider);
    changeHooks(provider, doc => { doc.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'echo operator' }] }); });
    expect(await check(provider)).toEqual([]);
  });

  it('names hooks when the entire settings document is missing', async () => {
    currentFixture(provider);
    fs.unlinkSync(path.join(projectRoot, hookFile(provider)));
    expect(await check(provider)).toContainEqual(expect.objectContaining({ name: 'UserPromptSubmit → aiwg-prompt-discovery', reason: 'missing' }));
  });

  it('does not claim malformed settings are current', async () => {
    currentFixture(provider);
    write(hookFile(provider), '{broken');
    expect(await check(provider)).toEqual([expect.objectContaining({ file: hookFile(provider), reason: 'unreadable' })]);
  });

  it('compiled dry-run names stale hooks and rules, offers one repair command, and writes nothing', () => {
    currentFixture(provider);
    changeHooks(provider, doc => { delete doc.hooks.UserPromptSubmit; });
    write(`.${provider}/rules/older-rule.md`, '<!-- aiwg:managed v2026.11.0 bundled -->\n');
    const before = snapshot();
    const output = cli(provider);
    expect(output).toContain('Stale deployment: missing UserPromptSubmit → aiwg-prompt-discovery');
    expect(output).toContain(`.${provider}/rules/older-rule.md`);
    expect(output).toContain(`aiwg use all --provider ${provider}`);
    expect(output).not.toContain('All deployments up to date');
    expect(snapshot()).toEqual(before);
  });

  it('compiled current dry-run reports up to date and writes nothing', () => {
    currentFixture(provider);
    const before = snapshot();
    expect(cli(provider)).toContain('All deployments up to date');
    expect(snapshot()).toEqual(before);
  });

  it('compiled quiet dry-run emits a single JSON report containing drift', () => {
    currentFixture(provider);
    changeHooks(provider, doc => { delete doc.hooks.UserPromptSubmit; });
    const before = snapshot();
    const report = JSON.parse(cli(provider, true));
    expect(report.staleManagedDeployments).toContainEqual(expect.objectContaining({ name: 'UserPromptSubmit → aiwg-prompt-discovery' }));
    expect(snapshot()).toEqual(before);
  });
});

it('scoped refresh uses the supplied project root and suppresses false success', async () => {
  currentFixture('claude');
  changeHooks('claude', doc => { delete doc.hooks.UserPromptSubmit; });
  const success = vi.spyOn(ui, 'success').mockImplementation(() => {});
  const warn = vi.spyOn(ui, 'warn').mockImplementation(() => {});
  const before = snapshot();
  expect((await refreshHandler.execute({ args: ['--dry-run', '--provider', 'claude'],
    rawArgs: ['refresh'], cwd: projectRoot, frameworkRoot })).exitCode).toBe(0);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing UserPromptSubmit → aiwg-prompt-discovery'));
  expect(success).not.toHaveBeenCalledWith('All deployments up to date');
  expect(snapshot()).toEqual(before);
});

it('accepts Claude registrations with the matcher preserved by the installer', async () => {
  currentFixture('claude');
  changeHooks('claude', doc => { doc.hooks.UserPromptSubmit[0].matcher = 'operator-pattern'; });
  await installAiwgHooks({ projectPath: projectRoot, frameworkRoot, attribution: false });
  expect(await check('claude')).toEqual([]);
});
