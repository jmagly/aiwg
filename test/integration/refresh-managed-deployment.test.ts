// Regression fixtures for hook/rule drift, including the compiled read-only CLI path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkManagedDeployment } from '../../src/cli/handlers/refresh-managed-deployment.js';
import { installAiwgHooks, managedClaudeHooks } from '../../src/extensions/claude-hooks-installer.js';
import { AIWG_MANAGED_HOOKS } from '../../src/extensions/muse-managed-hooks.js';
import { installFactoryPromptDiscovery, managedFactoryHooks } from '../../src/smiths/hook-bridge/factory-translator.js';
import { installCodexPromptDiscovery } from '../../src/smiths/hook-bridge/codex-translator.js';
import { refreshHandler } from '../../src/cli/handlers/refresh.js';
import * as ui from '../../src/cli/ui.js';

const frameworkRoot = path.resolve(import.meta.dirname, '../..');
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
  } else if (provider === 'factory') {
    for (const hook of managedFactoryHooks()) (hooks[hook.event] ??= []).push({ hooks: [{
      type: 'command', command: hook.command, _aiwg_id: hook.id, _aiwg_managed: true,
    }] });
    write('.factory/hooks.json', { hooks }); // legacy nested shape; refresh still reads it (#3971)
  } else if (provider === 'muse') {
    for (const hook of AIWG_MANAGED_HOOKS) (hooks[hook.event] ??= []).push(hook.group);
    write('.muse/hooks.json', { hooks });
    write('.muse/.aiwg-hooks.json', { version: 1, hooks: AIWG_MANAGED_HOOKS });
  }
  const ownedScripts = provider === 'claude'
    ? [...new Set(managedClaudeHooks(scripts).map(hook => path.basename(hook.script)))]
    : ['aiwg-prompt-discovery.cjs'];
  for (const script of ownedScripts) write(`.${provider}/hooks/${script}`, fs.readFileSync(
    path.join(frameworkRoot, 'agentic/code/addons/aiwg-hooks/hooks', script), 'utf8'));
  write(`.${provider}/rules/artifact-output-policy.md`, `<!-- aiwg:managed v${version} bundled -->\n# Current\n`);
}

function hookFile(provider: string) {
  return provider === 'claude' ? '.claude/settings.json' : `.${provider}/hooks.json`;
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

function cli(provider: string, quiet = false, dryRun = true) {
  return execFileSync(process.execPath, [path.join(frameworkRoot, 'bin/aiwg.mjs'), 'refresh',
    ...(dryRun ? ['--dry-run'] : ['--skip-update']),
    '--provider', provider, ...(quiet ? ['--quiet'] : [])], {
    cwd: projectRoot, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, AIWG_CONFIG: path.join(projectRoot, 'runtime-config'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-managed-drift-'));
  vi.stubEnv('HOME', path.join(projectRoot, 'home'));
  vi.stubEnv('XDG_DATA_HOME', path.join(projectRoot, 'data'));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe.each(['claude', 'muse', 'factory'])('%s managed deployment drift', provider => {
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

describe.each(['claude', 'muse', 'codex', 'factory'])('%s managed script bytes', provider => {
  const script = `.${provider}/hooks/aiwg-prompt-discovery.cjs`;
  const old = '// previous AIWG release\n';
  const edited = '// operator customization\n';
  const hash = (bytes: string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

  async function fixture() {
    currentFixture(provider);
    if (provider === 'factory') await installFactoryPromptDiscovery({ projectPath: projectRoot, frameworkRoot });
    if (provider === 'codex') await installCodexPromptDiscovery({ projectPath: projectRoot, frameworkRoot });
    // Refresh just the declared addon, with no remote packages or npm update.
    write('.aiwg/aiwg.config', { version: '1', providers: [provider], scripts: {}, installed: {
      'aiwg-hooks': { version, deployedTo: { [provider]: {} } },
    } });
  }

  function receipt(bytes: string) {
    write(`.${provider}/hooks/.aiwg-manifest.json`, { managed: {
      'aiwg-prompt-discovery.cjs': { hash: hash(bytes), kind: 'hook', owners: ['aiwg-hooks'] },
    } });
  }

  it('dry-run reports old bytes and real refresh replaces them even with a current receipt', async () => {
    await fixture();
    const expected = fs.readFileSync(path.join(projectRoot, script), 'utf8');
    write(script, old);
    receipt(old);
    const before = snapshot();
    const output = cli(provider);
    expect(output).toContain(`Stale deployment: outdated ${script}`);
    expect(output).not.toContain('All deployments up to date');
    expect(snapshot()).toEqual(before);
    expect(await check(provider)).toContainEqual({ name: script, file: script, reason: 'outdated' });
    cli(provider, false, false);
    expect(fs.readFileSync(path.join(projectRoot, script), 'utf8')).toBe(expected);
    expect(await check(provider)).toEqual([]);
  });

  it('accepts current bytes and leaves a dry run read-only', async () => {
    await fixture();
    receipt(fs.readFileSync(path.join(projectRoot, script), 'utf8'));
    const before = snapshot();
    expect(await check(provider)).toEqual([]);
    expect(cli(provider)).toContain('All deployments up to date');
    expect(snapshot()).toEqual(before);
  });

  it('checks every owned script, including legacy copies without receipts', async () => {
    await fixture();
    // Model a legacy deployment: Factory's current installer creates receipts.
    for (const receipt of [`.${provider}/hooks/.aiwg-manifest.json`, `.${provider}/.aiwg-manifest.json`]) {
      fs.rmSync(path.join(projectRoot, receipt), { force: true });
    }
    const files = fs.readdirSync(path.join(projectRoot, `.${provider}/hooks`)).filter(file => file.endsWith('.cjs'));
    for (const file of files) write(`.${provider}/hooks/${file}`, old);
    expect((await check(provider)).filter(item => item.reason === 'outdated').map(item => item.file).sort())
      .toEqual(files.map(file => `.${provider}/hooks/${file}`).sort());
    for (const file of files) fs.unlinkSync(path.join(projectRoot, `.${provider}/hooks/${file}`));
    expect((await check(provider)).filter(item => item.reason === 'missing').map(item => item.file).sort())
      .toEqual(files.map(file => `.${provider}/hooks/${file}`).sort());
  });

  it('names operator edits and preserves both the script and its original receipt during refresh', async () => {
    await fixture();
    receipt(old);
    write(script, edited);
    const before = snapshot();
    const output = cli(provider);
    expect(output).toContain(`operator-edited ${script}`);
    expect(output).toContain('kept; review operator edits');
    expect(output).not.toContain('All deployments up to date');
    expect(snapshot()).toEqual(before);
    cli(provider, false, false);
    expect(fs.readFileSync(path.join(projectRoot, script), 'utf8')).toBe(edited);
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, `.${provider}/hooks/.aiwg-manifest.json`), 'utf8'));
    expect(manifest.managed['aiwg-prompt-discovery.cjs'].hash).toBe(hash(old));
    expect(await check(provider)).toContainEqual({ name: script, file: script, reason: 'operator-edited' });
  });
});

it('compares Codex against the resolved canonical script argument', async () => {
  const packageRoot = path.join(projectRoot, 'package');
  write('package/package.json', { version });
  write('package/agentic/code/addons/aiwg-hooks/canonical/prompt.json', {
    id: 'aiwg-prompt-discovery', command: 'node', events: ['UserPromptSubmit'],
    args: ['$AIWG_ROOT/runtime/prompt.cjs'],
  });
  write('package/runtime/prompt.cjs', '// packaged hook bytes\n');
  await installCodexPromptDiscovery({ projectPath: projectRoot, frameworkRoot: packageRoot });
  expect(await checkManagedDeployment({ projectRoot, frameworkRoot: packageRoot, provider: 'codex', quiet: true })).toEqual([]);
  write('.codex/hooks/aiwg-prompt-discovery.cjs', '// obsolete\n');
  expect(await checkManagedDeployment({ projectRoot, frameworkRoot: packageRoot, provider: 'codex', quiet: true }))
    .toEqual([{ name: '.codex/hooks/aiwg-prompt-discovery.cjs', file: '.codex/hooks/aiwg-prompt-discovery.cjs', reason: 'outdated' }]);
});

it.each(['.claude/.aiwg-manifest.json', '.aiwg/.aiwg-manifest.json'])('honors ancestor ownership in %s', async receipt => {
  currentFixture('claude');
  const script = '.claude/hooks/aiwg-prompt-discovery.cjs';
  const name = receipt.startsWith('.aiwg/') ? script : 'hooks/aiwg-prompt-discovery.cjs';
  write(receipt, { scope: receipt.startsWith('.aiwg/') ? 'project' : undefined, managed: {
    [name]: { kind: 'hook', hash: 'sha256:previous-deployment', owners: ['aiwg-hooks'] },
  } });
  write(script, '// operator changes\n');
  const result = await installAiwgHooks({ projectPath: projectRoot, frameworkRoot });
  expect(result?.warnings).toContain(`${path.join(projectRoot, script)}: kept (operator-edited)`);
  expect(fs.readFileSync(path.join(projectRoot, script), 'utf8')).toBe('// operator changes\n');
  expect(await check('claude')).toEqual([{ name: script, file: script, reason: 'operator-edited' }]);
});

it('uses the nearest receipt when a newer deploy supersedes an ancestor claim', async () => {
  currentFixture('claude');
  const script = '.claude/hooks/aiwg-prompt-discovery.cjs';
  write('.claude/.aiwg-manifest.json', { managed: {
    'hooks/aiwg-prompt-discovery.cjs': { hash: 'sha256:older-ancestor-claim', kind: 'hook' },
  } });
  write('.claude/hooks/.aiwg-manifest.json', { managed: {
    'aiwg-prompt-discovery.cjs': { kind: 'hook', hash: 'sha256:' + createHash('sha256')
      .update(fs.readFileSync(path.join(projectRoot, script))).digest('hex') },
  } });
  expect(await check('claude')).toEqual([]);
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
