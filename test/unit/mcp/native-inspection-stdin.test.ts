// Native doctor/status/use probes must not create synchronous stdin pipes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: probe }));
import { inspectGrokBuildNative } from '../../../src/mcp/grok-build-config.mjs';
import { inspectMuseNative } from '../../../src/mcp/muse-native-config.mjs';
import { runGrokInspect } from '../../../src/providers/grok-build-inspect.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('native inspection in a sandbox with unusable stdin pipes', () => {
  it('keeps Grok status/doctor and deployment inspections functional', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-inspect-stdin-'));
    roots.push(root);
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, '# >>> AIWG-managed Grok MCP: aiwg\n');
    probe.mockImplementation((_binary, _args, options) => {
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      return { status: 0, stdout: '{"servers":["aiwg"]}', stderr: '' };
    });
    await expect(inspectGrokBuildNative({ projectDir: root, configPath, binary: 'fake-grok' }))
      .resolves.toMatchObject({ mcp: 'configured', diagnostics: [] });
    expect(probe).toHaveBeenCalledTimes(3);
    probe.mockImplementation((_binary, _args, options) => {
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      return { status: 0, stdout: '{"projectInstructions":[],"skills":[],"agents":[],"configSources":{"layers":[]}}', stderr: '' };
    });
    writeFileSync(join(root, 'grok'), '', { mode: 0o700 });
    expect(runGrokInspect({ env: { PATH: root }, cwd: root }).status).toBe('ok');
  });

  it('keeps the Muse version probe functional', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-muse-stdin-'));
    roots.push(root);
    probe.mockImplementation((_binary, _args, options) => {
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      return { status: 0, stdout: 'muse fixture\n', stderr: '' };
    });
    await expect(inspectMuseNative({ projectDir: root, userHome: root, env: { XDG_CONFIG_HOME: root } }))
      .resolves.toMatchObject({ cli: 'present (muse fixture)' });
  });
});
