/**
 * UAT: SE-002 — `clean:providers` preserves user-owned config
 *
 * Builds a scratch project tree containing:
 *   - AIWG-deployed state under every whole-remove target
 *     (`tools/cli/clean-providers.mjs` `WHOLE_REMOVE_TARGETS`) and every
 *     scoped claude/cursor/agents managed subpath
 *     (`resolveScopedProviderManagedPaths` / `resolveDirectoryManagedPaths`
 *     — read from the product's own registry, never hard-coded here);
 *   - operator-added entries in the three merge-target files
 *     (`.cursor/mcp.json`, Antigravity's `.agents/plugins/aiwg/mcp_config.json` and
 *     legacy `.agents/mcp_config.json`, `opencode.json`);
 *   - Claude-owned settings and worktree files AIWG never deploys to.
 *
 * Hashes every file before and after running the real `cleanProviders()`
 * implementation (imported directly — this is the same function
 * `npm run clean:providers` invokes against `process.cwd()`, called here
 * against the scratch project root instead of the real repo), then asserts
 * only the AIWG-owned paths were removed/rewritten and every other byte
 * survives.
 *
 * Run on demand (included in npm run uat):
 *   npm run uat
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { hashTree, diffTrees } from './helpers/hermetic-cli.js';

// @ts-ignore
const __dirname_uat = new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = resolve(__dirname_uat, '../..');

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function seedDeployedMarker(projectDir: string, relativeDir: string): void {
  mkdirSync(join(projectDir, relativeDir), { recursive: true });
  writeFileSync(join(projectDir, relativeDir, 'deployed.md'), `# aiwg-deployed under ${relativeDir}\n`);
}

describe('UAT: SE-002 — clean:providers removes only AIWG-owned entries', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(() => {
    projectDir = makeTmpDir('aiwg-uat-se002-proj-');
    configDir = makeTmpDir('aiwg-uat-se002-config-');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('removes AIWG-deployed state and merge entries; every operator byte survives', async () => {
    // @ts-ignore
    const cleanProviders = await import(join(PROJECT_ROOT, 'tools/cli/clean-providers.mjs'));
    // @ts-ignore - getMcpInjectionDefinition lives in the sibling .mjs module, not the .ts one
    const providerDefs = await import(join(PROJECT_ROOT, 'src/providers/provider-definitions.mjs'));

    // ── AIWG-deployed state, derived from the product's own registry ──
    for (const dir of cleanProviders.WHOLE_REMOVE_TARGETS) {
      if (dir.endsWith('.md')) { writeFileSync(join(projectDir, dir), '# aiwg-deployed\n'); continue; }
      seedDeployedMarker(projectDir, dir);
    }
    for (const relative of cleanProviders.resolveScopedProviderManagedPaths()) seedDeployedMarker(projectDir, relative);
    for (const dirPrefix of cleanProviders.SCOPED_DIRECTORIES) {
      for (const relative of cleanProviders.resolveDirectoryManagedPaths(dirPrefix)) seedDeployedMarker(projectDir, relative);
    }

    // ── Operator-owned state AIWG never deploys to, inside the shared .claude/ dir ──
    mkdirSync(join(projectDir, '.claude', 'worktrees'), { recursive: true });
    writeJson(join(projectDir, '.claude', 'settings.local.json'), { operator: 'local-setting' });
    writeJson(join(projectDir, '.claude', 'settings.json'), { operator: 'setting' });
    writeJson(join(projectDir, '.claude', 'launch.json'), { operator: 'launch' });
    writeJson(join(projectDir, '.claude', 'worktrees', 'branch-a.json'), { operator: 'worktree' });

    // ── Merge-target files: one AIWG-managed entry + one operator entry ──
    const cursorDef = providerDefs.getMcpInjectionDefinition('cursor');
    const antigravityDef = providerDefs.getMcpInjectionDefinition('antigravity');
    const opencodeDef = providerDefs.getMcpInjectionDefinition('opencode');
    mkdirSync(join(projectDir, '.cursor'), { recursive: true });
    writeJson(join(projectDir, cursorDef.configPath.path), {
      [cursorDef.serversKey]: {
        'aiwg-fortemi': { command: 'aiwg', args: ['mcp', 'serve'] },
        'operator-server': { command: 'operator-tool', args: ['--flag'] },
      },
    });
    // Antigravity: the native plugin config (#4496) plus the legacy flat config
    // an older AIWG wrote; clean:providers must strip AIWG entries from both.
    const antigravityLegacyPath = '.agents/mcp_config.json';
    expect(antigravityDef.configPath.path).not.toBe(antigravityLegacyPath);
    for (const relative of [antigravityDef.configPath.path, antigravityLegacyPath]) {
      mkdirSync(dirname(join(projectDir, relative)), { recursive: true });
      writeJson(join(projectDir, relative), {
        [antigravityDef.serversKey]: {
          'aiwg-fortemi': { command: 'aiwg', args: ['mcp', 'serve'] },
          'operator-server': { command: 'operator-tool', args: ['--flag'] },
        },
      });
    }
    writeJson(join(projectDir, opencodeDef.configPath.path), {
      instructions: ['WORKSPACE.md', 'AIWG.md', 'operator-instructions.md'],
      [opencodeDef.serversKey]: {},
      operatorTopLevel: 'kept',
    });

    // Central MCP server registry (global, under AIWG_CONFIG): records
    // "aiwg-fortemi" as injected into both cursor and antigravity, which is
    // what tells clean-providers that name (and only that name) is AIWG's.
    writeJson(join(configDir, 'mcp-servers.json'), {
      servers: { 'aiwg-fortemi': { injectedProviders: ['cursor', 'antigravity'] } },
    });

    const before = hashTree(projectDir);

    const originalAiwgConfig = process.env.AIWG_CONFIG;
    process.env.AIWG_CONFIG = configDir;
    let result: { removed: string[]; notes: string[] };
    try {
      result = await cleanProviders.cleanProviders(projectDir);
    } finally {
      if (originalAiwgConfig === undefined) delete process.env.AIWG_CONFIG;
      else process.env.AIWG_CONFIG = originalAiwgConfig;
    }

    const after = hashTree(projectDir);
    const diff = diffTrees(before, after);

    // Nothing is ever added by a cleanup pass.
    expect(diff.added).toEqual([]);

    // Only the merge-target files are rewritten in place (never removed —
    // each still has a surviving operator entry); everything else that
    // changed must be empty.
    expect(diff.changed.sort()).toEqual([
      antigravityDef.configPath.path, antigravityLegacyPath, cursorDef.configPath.path, opencodeDef.configPath.path,
    ].sort());

    // Every file under an AIWG-owned whole-remove or scoped-managed path was
    // actually removed, and nothing else was.
    const expectedRemovedPrefixes = [
      ...cleanProviders.WHOLE_REMOVE_TARGETS,
      ...cleanProviders.resolveScopedProviderManagedPaths(),
      ...cleanProviders.SCOPED_DIRECTORIES.flatMap((dir: string) => cleanProviders.resolveDirectoryManagedPaths(dir)),
    ];
    for (const removedPath of diff.removed) {
      const owned = expectedRemovedPrefixes.some((prefix: string) => removedPath === prefix || removedPath.startsWith(`${prefix}/`) || removedPath.startsWith(`${prefix}.`));
      expect(owned, `unexpected removal: ${removedPath}`).toBe(true);
    }
    // And every seeded AIWG marker file is actually gone.
    for (const prefix of expectedRemovedPrefixes) {
      if (prefix.endsWith('.md')) { expect(existsSync(join(projectDir, prefix))).toBe(false); continue; }
      expect(existsSync(join(projectDir, prefix, 'deployed.md')), `${prefix}/deployed.md should be removed`).toBe(false);
    }

    // Operator entries in the merge targets survive by value.
    const cursorAfter = JSON.parse(readFileSync(join(projectDir, cursorDef.configPath.path), 'utf-8'));
    expect(cursorAfter[cursorDef.serversKey]).toEqual({ 'operator-server': { command: 'operator-tool', args: ['--flag'] } });

    for (const relative of [antigravityDef.configPath.path, antigravityLegacyPath]) {
      const antigravityAfter = JSON.parse(readFileSync(join(projectDir, relative), 'utf-8'));
      expect(antigravityAfter[antigravityDef.serversKey], relative).toEqual({ 'operator-server': { command: 'operator-tool', args: ['--flag'] } });
    }

    const opencodeAfter = JSON.parse(readFileSync(join(projectDir, opencodeDef.configPath.path), 'utf-8'));
    expect(opencodeAfter.instructions).toEqual(['operator-instructions.md']);
    expect(opencodeAfter.operatorTopLevel).toBe('kept');

    // Claude-owned settings and worktree files are untouched (unchanged
    // means absent from both diff.changed and diff.removed above — assert
    // their hashes explicitly too, for a direct, named check).
    for (const relative of ['.claude/settings.local.json', '.claude/settings.json', '.claude/launch.json', '.claude/worktrees/branch-a.json']) {
      expect(before.get(relative)).toBeDefined();
      expect(after.get(relative), `${relative} must survive untouched`).toBe(before.get(relative));
    }

    expect(result.removed.length).toBeGreaterThan(0);
  });
});
