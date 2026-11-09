/**
 * Tests for the per-user AIWG registry (#1156 Phase 1).
 *
 * The registry lives at `~/.aiwg/installed.json`. We isolate by setting
 * HOME to a tmpdir for each test so writes don't leak into the real user
 * profile.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('user-registry (#1156)', () => {
  let tmpDir: string;
  let originalOverride: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-user-reg-'));
    originalOverride = process.env.AIWG_USER_REGISTRY_PATH;
    // Test-only env override — the registry helper checks this first and
    // bypasses the real ~/.aiwg/ entirely so we don't clobber the operator's
    // actual user-scope state.
    process.env.AIWG_USER_REGISTRY_PATH = path.join(tmpDir, 'installed.json');
  });

  afterEach(async () => {
    if (originalOverride !== undefined) process.env.AIWG_USER_REGISTRY_PATH = originalOverride;
    else delete process.env.AIWG_USER_REGISTRY_PATH;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty registry when file is missing', async () => {
    const { readUserRegistry } = await import('../../../src/config/user-registry.js');
    const r = await readUserRegistry();
    expect(r.version).toBe('1');
    expect(r.installed).toEqual({});
  });

  it('records a deploy and reads it back', async () => {
    const { recordUserDeploy, readUserRegistry } = await import(
      '../../../src/config/user-registry.js'
    );
    await recordUserDeploy({
      framework: 'sdlc',
      provider: 'claude',
      version: '2026.5.0',
      source: 'bundled',
      counts: { agents: 5, commands: 0, skills: 12, rules: 3 },
    });
    const r = await readUserRegistry();
    expect(r.installed.sdlc).toBeDefined();
    expect(r.installed.sdlc.deployedTo.claude).toEqual({
      agents: 5,
      commands: 0,
      skills: 12,
      rules: 3,
    });
    expect(r.installed.sdlc.version).toBe('2026.5.0');
  });

  it('overwrites prior counts when the same framework+provider is recorded twice', async () => {
    const { recordUserDeploy, readUserRegistry } = await import(
      '../../../src/config/user-registry.js'
    );
    await recordUserDeploy({
      framework: 'sdlc',
      provider: 'claude',
      version: '2026.5.0',
      source: 'bundled',
      counts: { agents: 5, commands: 0, skills: 12, rules: 3 },
    });
    await recordUserDeploy({
      framework: 'sdlc',
      provider: 'claude',
      version: '2026.5.1',
      source: 'bundled',
      counts: { agents: 6, commands: 0, skills: 14, rules: 3 },
    });
    const r = await readUserRegistry();
    expect(r.installed.sdlc.deployedTo.claude.agents).toBe(6);
    expect(r.installed.sdlc.version).toBe('2026.5.1');
  });

  it('keeps other-provider entries when removing one provider', async () => {
    const { recordUserDeploy, removeUserDeploy, readUserRegistry } = await import(
      '../../../src/config/user-registry.js'
    );
    await recordUserDeploy({
      framework: 'sdlc',
      provider: 'claude',
      version: '2026.5.0',
      source: 'bundled',
      counts: { agents: 5, commands: 0, skills: 12, rules: 3 },
    });
    await recordUserDeploy({
      framework: 'sdlc',
      provider: 'codex',
      version: '2026.5.0',
      source: 'bundled',
      counts: { agents: 0, commands: 5, skills: 12, rules: 0 },
    });
    await removeUserDeploy({ framework: 'sdlc', provider: 'claude' });
    const r = await readUserRegistry();
    expect(r.installed.sdlc).toBeDefined();
    expect(r.installed.sdlc.deployedTo.claude).toBeUndefined();
    expect(r.installed.sdlc.deployedTo.codex).toBeDefined();
  });

  it('removes the framework entry when the last provider is removed', async () => {
    const { recordUserDeploy, removeUserDeploy, readUserRegistry } = await import(
      '../../../src/config/user-registry.js'
    );
    await recordUserDeploy({
      framework: 'marketing',
      provider: 'claude',
      version: '1.0.0',
      source: 'bundled',
      counts: { agents: 1, commands: 0, skills: 1, rules: 0 },
    });
    await removeUserDeploy({ framework: 'marketing', provider: 'claude' });
    const r = await readUserRegistry();
    expect(r.installed.marketing).toBeUndefined();
  });

  it('removeUserDeploy without provider removes whole framework entry', async () => {
    const { recordUserDeploy, removeUserDeploy, readUserRegistry } = await import(
      '../../../src/config/user-registry.js'
    );
    await recordUserDeploy({
      framework: 'sdlc',
      provider: 'claude',
      version: '2026.5.0',
      source: 'bundled',
      counts: { agents: 5, commands: 0, skills: 12, rules: 3 },
    });
    await recordUserDeploy({
      framework: 'sdlc',
      provider: 'codex',
      version: '2026.5.0',
      source: 'bundled',
      counts: { agents: 0, commands: 5, skills: 12, rules: 0 },
    });
    await removeUserDeploy({ framework: 'sdlc' });
    const r = await readUserRegistry();
    expect(r.installed.sdlc).toBeUndefined();
  });

  // #1156 Cycle 3 — entries snapshot for precise remove
  it('records artifact entries when supplied', async () => {
    const { recordUserDeploy, readUserRegistry } = await import(
      '../../../src/config/user-registry.js'
    );
    await recordUserDeploy({
      framework: 'sdlc',
      provider: 'claude',
      version: '2026.5.0',
      source: 'bundled',
      counts: { agents: 2, commands: 0, skills: 3, rules: 1 },
      entries: {
        agents: ['agent-a', 'agent-b'],
        skills: ['sk1', 'sk2', 'sk3'],
        rules: ['rule-1.md'],
      },
    });
    const r = await readUserRegistry();
    const entry = r.installed.sdlc.deployedTo.claude as unknown as {
      entries?: { agents?: string[]; skills?: string[]; rules?: string[] };
    };
    expect(entry.entries?.agents).toEqual(['agent-a', 'agent-b']);
    expect(entry.entries?.skills).toEqual(['sk1', 'sk2', 'sk3']);
    expect(entry.entries?.rules).toEqual(['rule-1.md']);
  });

  it('returns empty registry on parse failure', async () => {
    const { userRegistryPath, readUserRegistry } = await import(
      '../../../src/config/user-registry.js'
    );
    const p = userRegistryPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, '{not json', 'utf-8');
    const r = await readUserRegistry();
    expect(r.installed).toEqual({});
  });

  it('exposes override detection and operator warn copy (#246)', async () => {
    const {
      isUserRegistryPathOverrideActive,
      USER_REGISTRY_PATH_OVERRIDE_WARN,
      userRegistryPath,
    } = await import('../../../src/config/user-registry.js');
    expect(isUserRegistryPathOverrideActive()).toBe(true);
    expect(userRegistryPath()).toBe(process.env.AIWG_USER_REGISTRY_PATH);
    expect(USER_REGISTRY_PATH_OVERRIDE_WARN).toContain('test override active');
    expect(USER_REGISTRY_PATH_OVERRIDE_WARN).toContain('~/.aiwg/installed.json');
  });

  it('makes user receipts available for home trees only (#4028)', async () => {
    const { homeDeploymentReceipts, recordUserDeploy } = await import('../../../src/config/user-registry.js');
    expect(await homeDeploymentReceipts(tmpDir)).toEqual([]);
    expect(await homeDeploymentReceipts(os.homedir())).toEqual([]);
    await recordUserDeploy({ framework: 'all', provider: 'claude', version: 'test', source: 'bundled',
      counts: { agents: 0, commands: 0, skills: 26, rules: 12 } });
    const receipts = await homeDeploymentReceipts(os.homedir());
    expect(receipts).toHaveLength(1);
    expect(receipts[0][0]).toBe('user:all');
    expect(receipts[0][1].deployedTo.claude.agents).toBe(0);
    expect(await homeDeploymentReceipts(path.join(os.homedir(), 'project'))).toEqual([]);
  });

});
