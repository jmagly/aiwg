// Deploy only into private synthetic projects; execute the generated hook with fake tool events.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkWorkerHealthReadiness } from '../../../tools/cli/doctor-worker-health.mjs';
import { postDeploy as claudePostDeploy } from '../../../tools/agents/providers/claude.mjs';
import { postDeploy as codexPostDeploy } from '../../../tools/agents/providers/codex.mjs';
import { deployConductorDataGuard } from '../../../tools/agents/providers/conductor-data-guard.mjs';

let root: string;
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const hook = (input: unknown) => spawnSync(process.execPath, [path.join(root, '.claude/hooks/aiwg-local-only.mjs')], {
  input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', cwd: root, timeout: 10000,
});
const event = (tool_name: string, tool_input: object) => ({ tool_name, tool_input, cwd: root });
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiwg-data-guard-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('AIWG_CONFIG', path.join(root, 'user-config'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  mkdirSync(path.join(root, 'eval-work'));
  writeFileSync(path.join(root, 'eval-work/local.txt'), 'SYNTHETIC-PRIVATE-CONTENT');
  writeFileSync(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
    dataClasses: { 'local-only': { allowedProcessing: ['local'], localOnlyPaths: ['eval-work/local.txt'] } },
  } } }));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('T-OG-01 conductor data guard provider deployment', () => {
  it('Claude installs refusals, preserves operator settings and is idempotent', async () => {
    mkdirSync(path.join(root, '.claude'));
    writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(pwd)'], deny: ['Read(.env)'] },
      hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'operator-hook' }] }] } }));
    await claudePostDeploy(root, { contextFiles: false });
    await claudePostDeploy(root, { contextFiles: false });
    const settings = json('.claude/settings.json');
    expect(settings.permissions.allow).toEqual(['Bash(pwd)']);
    expect(settings.permissions.deny).toContain('Read(.env)');
    expect(settings.permissions.deny).toContain(`Read(/${root}/eval-work/local.txt)`);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    const denied = hook(event('Bash', { command: 'ls -la . && cat eval-work/local.txt 2>/dev/null | head -5 && pwd' }));
    expect(denied.status, denied.stderr).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.stdout).not.toContain('SYNTHETIC-PRIVATE-CONTENT');
    const read = hook(event('Read', { file_path: path.join(root, 'eval-work/local.txt') }));
    expect(JSON.parse(read.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const allowed = hook(event('Bash', { command: 'cat README.md' }));
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toBe('');
    expect(hook('invalid-json').status).toBe(2);
  });
  it('deploys without any model config when no local-only paths are declared', async () => {
    // The slim CLI package ships no framework default models config; an ordinary
    // deploy must not need it.
    rmSync(path.join(root, 'models.json'));
    vi.stubEnv('AIWG_HOME', mkdtempSync(path.join(root, 'no-defaults-')));
    await expect(claudePostDeploy(root, { contextFiles: false })).resolves.not.toThrow();
    await expect(codexPostDeploy(root, { contextFiles: false })).resolves.not.toThrow();
    expect(() => readFileSync(path.join(root, '.claude/hooks/aiwg-local-only.mjs'))).toThrow();
    expect(() => readFileSync(path.join(root, '.codex/rules/aiwg-local-only.rules'))).toThrow();
  });
  it('deployed Claude hook refuses glob expansion and recursive ancestor reads', async () => {
    await claudePostDeploy(root, { contextFiles: false });
    for (const command of [
      'for f in eval-work/*.json eval-work/*.txt .eval-control/policy.md; do echo "=== $f ==="; cat "$f"; done',
      'grep -r x eval-work', 'rg x eval-work', 'find eval-work -exec cat {} \\;',
      'cat eval-work/loc?l.txt', 'cat eval-work/[kl]ocal.txt', 'cat **/local.txt',
    ]) {
      const denied = hook(event('Bash', { command }));
      expect(denied.status, denied.stderr).toBe(0);
      expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, command).toBe('deny');
      expect(denied.stdout).not.toContain('SYNTHETIC-PRIVATE-CONTENT');
    }
    for (const command of ['cat eval-work/public.txt', 'ls eval-work', 'cat eval-work/*.json', 'cat "eval-work/*.txt"']) {
      const allowed = hook(event('Bash', { command }));
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout, command).toBe('');
    }
    for (const malformed of ['invalid-json', null, {}, { tool_name: 'Bash' }]) {
      expect(hook(malformed).status).toBe(2);
    }
  });
  it('deployed Claude hook protects directory subtrees reached by a glob', async () => {
    mkdirSync(path.join(root, 'private-inputs'));
    writeFileSync(path.join(root, 'private-inputs/input.txt'), 'SYNTHETIC-PRIVATE-CONTENT');
    writeFileSync(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
      dataPolicy: { localOnlyPaths: ['private-inputs'] },
    } } }));
    await claudePostDeploy(root, { contextFiles: false });
    const denied = hook(event('Bash', { command: 'cat private-inputs/*' }));
    expect(denied.status, denied.stderr).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.stdout).not.toContain('SYNTHETIC-PRIVATE-CONTENT');
  });
  it.each(['project', 'user'])('deploys opt-in execution checks from %s policy without local-only inputs', async source => {
    rmSync(path.join(root, 'models.json'));
    const configDir = source === 'project' ? root : path.join(root, 'user-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
      guards: { denyConductorWorkerExecution: true },
    } } }));
    mkdirSync(path.join(root, '.aiwg'));
    writeFileSync(path.join(root, '.aiwg/aiwg.config'), JSON.stringify({ parallelism: { worker_dispatch: true } }));
    await claudePostDeploy(root, { contextFiles: false });
    // Trees can be prepared after deployment; the hook reads the existing Git registry per event.
    const tree = path.join(root, '.eval-control/worker-tree');
    mkdirSync(path.join(tree, 'eval-work'), { recursive: true });
    mkdirSync(path.join(root, '.git/worktrees/worker'), { recursive: true });
    writeFileSync(path.join(root, '.git/worktrees/worker/gitdir'), path.join(tree, '.git') + '\n');
    writeFileSync(path.join(tree, 'eval-work/reset.mjs'), 'throw new Error("MUST NEVER EXECUTE");');
    const records = JSON.parse(readFileSync(new URL('../../fixtures/models/conductor-worker-commands.json', import.meta.url), 'utf8'));
    for (const record of records) {
      const replay = JSON.parse(JSON.stringify(record.event).replaceAll(record.root, root));
      const denied = hook(replay);
      expect(denied.status, denied.stderr).toBe(0);
      expect(JSON.parse(denied.stdout).hookSpecificOutput).toMatchObject({
        permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('aiwg ralph-external --verify-worker'),
      });
      expect(denied.stdout).not.toContain('MUST NEVER EXECUTE');
    }
    for (const command of ['git -C .eval-control/worker-tree diff', 'cat .eval-control/worker-tree/eval-work/reset.mjs',
      'aiwg ralph-external --verify-worker --run-dir /private/run --check \'{"id":"unit","command":"/usr/bin/node","args":["test.mjs"]}\'']) {
      const allowed = hook(event('Bash', { command }));
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout).toBe('');
    }
  });
  it.each([undefined, false])('worker dispatch leaves settings and deploy output unchanged with guard %s', async enabled => {
    rmSync(path.join(root, 'models.json'));
    if (enabled !== undefined) writeFileSync(path.join(root, 'models.json'), JSON.stringify({ defaults: {
      workerSelection: { guards: { denyConductorWorkerExecution: enabled } },
    } }));
    vi.stubEnv('AIWG_HOME', mkdtempSync(path.join(root, 'no-defaults-')));
    mkdirSync(path.join(root, '.aiwg'));
    writeFileSync(path.join(root, '.aiwg/aiwg.config'), JSON.stringify({ parallelism: { worker_dispatch: true } }));
    mkdirSync(path.join(root, '.claude'));
    const settings = '{ "permissions": { "allow": ["Bash(pwd)"] } }\n';
    writeFileSync(path.join(root, '.claude/settings.json'), settings);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await deployConductorDataGuard(root, 'claude')).toEqual([]);
      expect(readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).toBe(settings);
      expect(() => readFileSync(path.join(root, '.claude/hooks/aiwg-local-only.mjs'))).toThrow();
      expect(output).not.toHaveBeenCalled();
    } finally { output.mockRestore(); }
  });
  it.each([undefined, false])('local-only hook allows recorded execution when guard is %s', async enabled => {
    const models = json('models.json');
    if (enabled !== undefined) models.defaults.workerSelection.guards = { denyConductorWorkerExecution: enabled };
    writeFileSync(path.join(root, 'models.json'), JSON.stringify(models));
    await claudePostDeploy(root, { contextFiles: false });
    mkdirSync(path.join(root, '.git/worktrees/worker'), { recursive: true });
    writeFileSync(path.join(root, '.git/worktrees/worker/gitdir'), path.join(root, '.eval-control/worker-tree/.git'));
    const records = JSON.parse(readFileSync(new URL('../../fixtures/models/conductor-worker-commands.json', import.meta.url), 'utf8'));
    for (const record of records) {
      const replay = JSON.parse(JSON.stringify(record.event).replaceAll(record.root, root));
      const allowed = hook(replay);
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout, record.source).toBe('');
    }
    const denied = hook(event('Bash', { command: 'cat eval-work/local.txt' }));
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each([undefined, false])('redeployment disables a previous execution opt-in when set to %s', async enabled => {
    writeFileSync(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
      guards: { denyConductorWorkerExecution: true },
    } } }));
    await deployConductorDataGuard(root, 'claude');
    const command = event('Bash', { command: 'node .aiwg/working/worktrees/worker/test.mjs' });
    expect(JSON.parse(hook(command).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const settings = readFileSync(path.join(root, '.claude/settings.json'), 'utf8');
    writeFileSync(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
      guards: enabled === undefined ? {} : { denyConductorWorkerExecution: enabled },
    } } }));
    await deployConductorDataGuard(root, 'claude', { dryRun: true });
    expect(JSON.parse(hook(command).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    await deployConductorDataGuard(root, 'claude');
    const allowed = hook(command);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toBe('');
    expect(readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).toBe(settings);
  });
  it('opt-in is independent of worker dispatch and ignored for Codex execution checks', async () => {
    writeFileSync(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
      guards: { denyConductorWorkerExecution: true },
    } } }));
    await deployConductorDataGuard(root, 'codex');
    expect(() => readFileSync(path.join(root, '.codex/rules/aiwg-local-only.rules'))).toThrow();
    await deployConductorDataGuard(root, 'claude');
    const denied = hook(event('Bash', { command: 'node .aiwg/working/worktrees/worker/test.mjs' }));
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('Codex emits forbidden explicit reader prefixes in project rules', async () => {
    await codexPostDeploy(root, { contextFiles: false });
    const rules = readFileSync(path.join(root, '.codex/rules/aiwg-local-only.rules'), 'utf8');
    expect(rules).toContain('prefix_rule(pattern = ["cat","eval-work/local.txt"], decision = "forbidden")');
    expect(rules).toContain(JSON.stringify(['cat', path.join(root, 'eval-work/local.txt')]));
    expect(rules).not.toContain('SYNTHETIC-PRIVATE-CONTENT');
  });
  it('doctor reports protected paths when dispatch is disabled', async () => {
    const check = vi.fn();
    await checkWorkerHealthReadiness({ config: null, configFailed: false, AIWG_ROOT: process.cwd(), cwd: root, check });
    expect(check.mock.calls.some(call => call[2].includes('eval-work/local.txt'))).toBe(true);
  });
  it('dry-run writes no settings or hooks', async () => {
    await claudePostDeploy(root, { contextFiles: false, dryRun: true });
    expect(() => json('.claude/settings.json')).toThrow();
  });
  it('invalid path declarations fail deployment before publishing a hook', async () => {
    writeFileSync(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: { dataPolicy: { localOnlyPaths: ['../secret'] } } } }));
    await expect(claudePostDeploy(root, { contextFiles: false })).rejects.toThrow();
    expect(() => json('.claude/settings.json')).toThrow();
  });
});
