// Assert working context delivery and explicit bridge gaps for prompt discovery.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, unlink, access, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookSources } from '../../../src/smiths/hook-bridge/loader.js';
import { spawnSync } from 'node:child_process';
import { postDeploy as postDeployCodex } from '../../../tools/agents/providers/codex-post-deploy.mjs';
import { translateForCodex } from '../../../src/smiths/hook-bridge/codex-translator.js';
import { translateForHermes } from '../../../src/smiths/hook-bridge/hermes-translator.js';
import { deployMuseHooks, pruneMuseHooks } from '../../../tools/agents/providers/muse-hooks.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let projectPath: string;
beforeEach(async () => {
  projectPath = await mkdtemp(path.join(tmpdir(), 'aiwg-prompt-providers-'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(projectPath, { recursive: true, force: true }); });

describe('prompt discovery provider delivery', () => {
  it('registers the Codex prompt hook by default, preserving operator hooks and repairing the script', async () => {
    const settings = path.join(projectPath, '.codex/hooks.json');
    await mkdir(path.dirname(settings), { recursive: true });
    const operator = { hooks: [{ type: 'command', command: 'echo operator' }] };
    await writeFile(settings, JSON.stringify({ hooks: { UserPromptSubmit: [operator] } }));
    const opts = { srcRoot: root, mode: 'sdlc', quiet: true, contextFiles: false };
    await postDeployCodex(projectPath, opts);
    const once = await readFile(settings, 'utf8');
    const groups = JSON.parse(once).hooks.UserPromptSubmit;
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual(operator);
    const script = path.join(projectPath, '.codex/hooks/aiwg-prompt-discovery.cjs');
    expect(groups[1].hooks[0]).toEqual({ type: 'command', command: `node "${script}"`, timeout: 2,
      _aiwg_managed: true, _aiwg_id: 'aiwg-prompt-discovery' });
    const shared = await readFile(path.join(root, 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs'), 'utf8');
    expect(await readFile(script, 'utf8')).toBe(shared);
    await unlink(script);
    await postDeployCodex(projectPath, { ...opts, srcRoot: path.join(root, 'agentic/code/addons/aiwg-hooks') });
    expect(await readFile(script, 'utf8')).toBe(shared);
    expect(await readFile(settings, 'utf8')).toBe(once);
  });

  it.each([{ hooks: false }, { scope: 'user' }, { skillsOnly: true }, { commandsOnly: true }, { rulesOnly: true }, { dryRun: true }])
  ('skips Codex hooks for %j', async controls => {
    await postDeployCodex(projectPath, { srcRoot: root, mode: 'sdlc', quiet: true, contextFiles: false, ...controls });
    await expect(access(path.join(projectPath, '.codex/hooks.json'))).rejects.toThrow();
    await expect(access(path.join(projectPath, '.codex/hooks'))).rejects.toThrow();
  });

  it('includes Codex hooks in the kernel-only path used by aiwg use all', async () => {
    await postDeployCodex(projectPath, { srcRoot: root, mode: 'sdlc', quiet: true, contextFiles: false,
      skillsOnly: true, kernelOnly: true });
    await access(path.join(projectPath, '.codex/hooks.json'));
  });

  it('runs the registered Codex command with the shared context, skip and opt-out contract', async () => {
    const loaded = await loadHookSources(root);
    expect(loaded.errors).toEqual([]);
    const source = loaded.sources.find(s => s.id === 'aiwg-prompt-discovery')!;
    expect(source.degradeOn).not.toContain('codex');
    const target = path.join(projectPath, 'project $AIWG_NOT_DEFINED with spaces');
    await mkdir(target);
    const result = await translateForCodex(source, { projectPath: target });
    expect(result.skipped).toBe(false);
    const groups = JSON.parse(await readFile(result.emittedPaths[0], 'utf8')).hooks.UserPromptSubmit;
    const runtime = path.join(projectPath, 'runtime/dist/src/artifacts');
    await mkdir(runtime, { recursive: true });
    await copyFile(path.join(root, 'test/fixtures/hooks-prompt-discovery.mjs'), path.join(runtime, 'query-engine-discover.js'));
    const invoke = (prompt: string, enabled = '1') => spawnSync(groups[0].hooks[0].command, {
      cwd: target, shell: true, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, AIWG_ROOT: path.join(projectPath, 'runtime'), AIWG_PROMPT_DISCOVERY: enabled },
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }),
    });
    const run = invoke('Review the authentication code for security issues');
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('skill security-review'),
    });
    for (const run of [invoke('ok'), invoke('/help'), invoke('Review authentication', '0')]) {
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe('');
    }
  });

  it('deploys the same hook for Muse with an idempotent registration and repairs a missing script', async () => {
    deployMuseHooks(projectPath, { quiet: true });
    const settings = path.join(projectPath, '.muse/hooks.json');
    const once = await readFile(settings, 'utf8');
    const registration = JSON.parse(once).hooks.UserPromptSubmit;
    expect(registration).toEqual([{ matcher: '*', hooks: [{
      type: 'command', command: 'node .muse/hooks/aiwg-prompt-discovery.cjs', timeout: 2,
    }] }]);
    const script = path.join(projectPath, '.muse/hooks/aiwg-prompt-discovery.cjs');
    expect(await readFile(script, 'utf8')).toBe(await readFile(path.join(root,
      'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs'), 'utf8'));
    await unlink(script);
    deployMuseHooks(projectPath, { quiet: true });
    await access(script);
    expect(await readFile(settings, 'utf8')).toBe(once);
    pruneMuseHooks(projectPath, { quiet: true });
    expect(JSON.parse(await readFile(settings, 'utf8')).hooks.UserPromptSubmit).toEqual([]);
  });

  it('keeps Muse dry-run free of script and settings writes', async () => {
    deployMuseHooks(projectPath, { dryRun: true, quiet: true });
    await expect(access(path.join(projectPath, '.muse'))).rejects.toThrow();
  });

  it.each([
    ['hermes', translateForHermes, 'exit code'],
  ] as const)('reports the %s context injection gap without writing native config', async (provider, translate, reason) => {
    const loaded = await loadHookSources(root);
    expect(loaded.errors).toEqual([]);
    const source = loaded.sources.find(s => s.id === 'aiwg-prompt-discovery');
    expect(source?.events).toEqual(['UserPromptSubmit']);
    expect(source?.degradeOn).toContain(provider);
    const result = await translate(source!, { projectPath });
    expect(result.skipped).toBe(true);
    expect(result.emittedPaths).toEqual([]);
    expect(result.skipReason).toContain(reason);
    expect(result.skipReason).toContain('additionalContext');
    const docs = await readFile(path.join(root, 'docs/hook-patterns.md'), 'utf8');
    expect(docs).toContain('| Hermes | Explicit gap:');
  });
});
