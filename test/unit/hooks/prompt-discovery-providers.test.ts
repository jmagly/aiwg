// Assert working context delivery and explicit bridge gaps for prompt discovery.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookSources } from '../../../src/smiths/hook-bridge/loader.js';
import { translateForCodex } from '../../../src/smiths/hook-bridge/codex-translator.js';
import { translateForHermes } from '../../../src/smiths/hook-bridge/hermes-translator.js';
import { deployMuseHooks, pruneMuseHooks } from '../../../tools/agents/providers/muse-hooks.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let projectPath: string;
beforeEach(async () => { projectPath = await mkdtemp(path.join(tmpdir(), 'aiwg-prompt-providers-')); });
afterEach(async () => { await rm(projectPath, { recursive: true, force: true }); });

describe('prompt discovery provider delivery', () => {
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
    ['codex', translateForCodex, 'before_prompt'],
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
    expect(docs).toContain(provider === 'codex' ? '| Codex | Explicit gap:' : '| Hermes | Explicit gap:');
  });
});
