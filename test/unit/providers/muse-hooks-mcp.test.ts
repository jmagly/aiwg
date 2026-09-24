/**
 * Muse hooks (.muse/hooks.json) + optional MCP settings profile tests (#228).
 *
 * Covers:
 * - additive hooks merge (operator entries preserved, managed entries
 *   refreshed, sidecar-tracked identity — never in-band tags)
 * - merge/no-clobber: drifted managed groups repaired, operator groups
 *   byte-logical, retired managed entries pruned
 * - fail closed on unparseable hooks.json / settings.json (zero writes)
 * - dry-run diffs with zero writes for both hooks and MCP
 * - MCP profile: explicit opt-in only, additive mcp_servers merge, unknown
 *   keys preserved, schema_version bootstrap/preserve, backup before write,
 *   operator-owned `aiwg` key never clobbered
 * - writer wiring: hooks default on (--no-hooks opts out), MCP off by default
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MUSE_HOOKS_REL,
  MUSE_HOOKS_SIDECAR_REL,
  MUSE_HOOK_EVENTS,
  AIWG_MANAGED_HOOKS,
  MUSE_MCP_SIDECAR_NAME,
  mergeManagedHooks,
  deployMuseHooks,
  pruneMuseHooks,
  assertMuseUserSettingsPath,
  aiwgMcpServerProfile,
  mergeMcpProfile,
  deployMuseMcp,
  pruneMuseMcp,
} from '../../../tools/agents/providers/muse-hooks.mjs';
import { postDeploy } from '../../../tools/agents/providers/muse.mjs';

const HOME = path.join(path.sep, 'home', 'fixture');
const repoRoot = path.resolve(__dirname, '..', '..', '..');

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-hooks-mcp-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function hooksPath(target: string): string {
  return path.join(target, MUSE_HOOKS_REL);
}

function sidecarPath(target: string): string {
  return path.join(target, MUSE_HOOKS_SIDECAR_REL);
}

function writeHooks(target: string, content: string) {
  fs.mkdirSync(path.dirname(hooksPath(target)), { recursive: true });
  fs.writeFileSync(hooksPath(target), content, 'utf8');
}

function readJson(p: string) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function xdgEnv() {
  return { XDG_CONFIG_HOME: path.join(tmpRoot, 'xdg') };
}

function settingsPath() {
  return path.join(tmpRoot, 'xdg', 'muse', 'settings.json');
}

// ---------------------------------------------------------------------------
// Managed hook set definition
// ---------------------------------------------------------------------------

describe('AIWG_MANAGED_HOOKS (#228)', () => {
  it('binds only to documented Muse lifecycle events', () => {
    for (const hook of AIWG_MANAGED_HOOKS) {
      expect(MUSE_HOOK_EVENTS).toContain(hook.event);
    }
  });

  it('ships a stated reason and removal path per hook', () => {
    expect(AIWG_MANAGED_HOOKS.length).toBeGreaterThan(0);
    for (const hook of AIWG_MANAGED_HOOKS) {
      expect(hook.reason).toMatch(/\S/);
      expect(hook.removal).toMatch(/\S/);
    }
  });

  it('uses only Muse-supported matcher-group keys (hooks + matcher)', () => {
    // Muse skips groups with unexpected keys; in-band AIWG tags are forbidden.
    for (const hook of AIWG_MANAGED_HOOKS) {
      expect(Object.keys(hook.group).sort()).toEqual(['hooks', 'matcher']);
      for (const entry of hook.group.hooks) {
        expect(entry.type).toBe('command');
        expect(entry.command).toMatch(/\S/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Hooks merge semantics
// ---------------------------------------------------------------------------

describe('mergeManagedHooks (#228)', () => {
  it('installs the managed set into an empty document', () => {
    const { doc, changed, plan } = mergeManagedHooks({ hooks: {} }, { version: 1, hooks: [] });
    expect(changed).toBe(true);
    expect(doc.hooks.SessionStart).toHaveLength(1);
    expect(doc.hooks.SessionStart[0].hooks[0].command).toBe('aiwg sync --dry-run --quiet');
    expect(plan.join('\n')).toContain('aiwg-session-start');
  });

  it('is a no-op when the canonical set is already installed', () => {
    const canonical = { hooks: { SessionStart: [AIWG_MANAGED_HOOKS[0].group] } };
    const sidecar = {
      version: 1,
      hooks: [{ id: 'aiwg-session-start', event: 'SessionStart', group: AIWG_MANAGED_HOOKS[0].group }],
    };
    const { changed, plan } = mergeManagedHooks(canonical, sidecar);
    expect(changed).toBe(false);
    expect(plan).toEqual([]);
  });

  it('preserves operator groups and appends managed groups additively', () => {
    const operatorGroup = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: './audit.sh' }],
    };
    const { doc } = mergeManagedHooks(
      { hooks: { PreToolUse: [operatorGroup] } },
      { version: 1, hooks: [] },
    );
    expect(doc.hooks.PreToolUse).toEqual([operatorGroup]);
    expect(doc.hooks.SessionStart).toHaveLength(1);
    // Operator event keeps its position ahead of the managed event.
    expect(Object.keys(doc.hooks)).toEqual(['PreToolUse', 'SessionStart']);
  });

  it('repairs a drifted managed group recorded in the sidecar', () => {
    const drifted = {
      matcher: '*',
      hooks: [{ type: 'command', command: 'aiwg sync --dry-run --quiet --extra-flag', timeout: 60 }],
    };
    const sidecar = {
      version: 1,
      hooks: [{ id: 'aiwg-session-start', event: 'SessionStart', group: AIWG_MANAGED_HOOKS[0].group }],
    };
    const { doc, changed, plan } = mergeManagedHooks({ hooks: { SessionStart: [drifted] } }, sidecar);
    expect(changed).toBe(true);
    expect(doc.hooks.SessionStart).toEqual([AIWG_MANAGED_HOOKS[0].group]);
    expect(plan.join('\n')).toMatch(/repair/);
  });

  it('prunes a previously-managed hook that left the set', () => {
    const retired = { matcher: '*', hooks: [{ type: 'command', command: 'aiwg retired-cmd' }] };
    const sidecar = {
      version: 1,
      hooks: [{ id: 'aiwg-retired', event: 'SessionStart', group: retired }],
    };
    const { doc, changed, plan } = mergeManagedHooks({ hooks: { SessionStart: [retired] } }, sidecar);
    expect(changed).toBe(true);
    // Retired group dropped; current managed set installed.
    expect(doc.hooks.SessionStart).toEqual([AIWG_MANAGED_HOOKS[0].group]);
    expect(plan.join('\n')).toMatch(/prune retired/);
  });
});

// ---------------------------------------------------------------------------
// deployMuseHooks: filesystem behavior
// ---------------------------------------------------------------------------

describe('deployMuseHooks (#228)', () => {
  it('dry-run performs zero writes and reports the planned diff', () => {
    const target = path.join(tmpRoot, 'project');
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      const result = deployMuseHooks(target, { dryRun: true, quiet: false });
      expect(result.changed).toBe(true);
      expect(result.wrote).toBe(false);
    } finally {
      console.log = origLog;
    }
    expect(fs.existsSync(path.join(target, '.muse'))).toBe(false);
    expect(logs.join('\n')).toContain('[dry-run]');
    expect(logs.join('\n')).toContain('zero writes');
  });

  it('writes hooks.json plus a sidecar, and is idempotent', () => {
    const target = path.join(tmpRoot, 'project');
    const first = deployMuseHooks(target, { quiet: true });
    expect(first.wrote).toBe(true);
    const doc = readJson(hooksPath(target));
    expect(doc.hooks.SessionStart[0].hooks[0].command).toBe('aiwg sync --dry-run --quiet');
    const sidecar = readJson(sidecarPath(target));
    expect(sidecar.hooks.map((h: { id: string }) => h.id)).toContain('aiwg-session-start');

    const second = deployMuseHooks(target, { quiet: true });
    expect(second.changed).toBe(false);
    expect(second.wrote).toBe(false);
  });

  it('merges into an existing operator hooks.json without clobbering it', () => {
    const target = path.join(tmpRoot, 'project');
    const operatorGroup = {
      matcher: 'Write',
      hooks: [{ type: 'command', command: './operator-check.sh' }],
    };
    writeHooks(target, JSON.stringify({ hooks: { PreToolUse: [operatorGroup] } }, null, 2));
    deployMuseHooks(target, { quiet: true });
    const doc = readJson(hooksPath(target));
    expect(doc.hooks.PreToolUse).toEqual([operatorGroup]);
    expect(doc.hooks.SessionStart).toHaveLength(1);
  });

  it('tolerates JSONC comments on read', () => {
    const target = path.join(tmpRoot, 'project');
    writeHooks(target, '// operator note\n{\n  /* block */\n  "hooks": {}\n}\n');
    const result = deployMuseHooks(target, { quiet: true });
    expect(result.wrote).toBe(true);
    expect(readJson(hooksPath(target)).hooks.SessionStart).toHaveLength(1);
  });

  it('fails closed on unparseable hooks.json with zero writes', () => {
    const target = path.join(tmpRoot, 'project');
    writeHooks(target, '{ not valid json');
    const before = fs.readFileSync(hooksPath(target), 'utf8');
    expect(() => deployMuseHooks(target, { quiet: true })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(hooksPath(target), 'utf8')).toBe(before);
    expect(fs.existsSync(sidecarPath(target))).toBe(false);
  });

  it('fails closed on a non-object hooks field and on non-array events', () => {
    const target = path.join(tmpRoot, 'project');
    writeHooks(target, JSON.stringify({ hooks: ['nope'] }));
    expect(() => deployMuseHooks(target, { quiet: true })).toThrow(/"hooks" must be an object/);

    writeHooks(target, JSON.stringify({ hooks: { SessionStart: { matcher: '*' } } }));
    expect(() => deployMuseHooks(target, { quiet: true })).toThrow(/must be an array/);
  });
});

describe('pruneMuseHooks (#228)', () => {
  it('removes only managed groups and deletes the sidecar', () => {
    const target = path.join(tmpRoot, 'project');
    deployMuseHooks(target, { quiet: true });
    // Operator adds their own SessionStart group after the managed deploy.
    const doc = readJson(hooksPath(target));
    const operatorGroup = { matcher: '*', hooks: [{ type: 'command', command: './mine.sh' }] };
    doc.hooks.SessionStart.push(operatorGroup);
    fs.writeFileSync(hooksPath(target), JSON.stringify(doc, null, 2), 'utf8');

    const result = pruneMuseHooks(target, { quiet: true });
    expect(result.pruned).toBe(1);
    expect(result.wrote).toBe(true);
    const pruned = readJson(hooksPath(target));
    expect(pruned.hooks.SessionStart).toEqual([operatorGroup]);
    expect(fs.existsSync(sidecarPath(target))).toBe(false);
  });

  it('dry-run prunes nothing and reports the plan', () => {
    const target = path.join(tmpRoot, 'project');
    deployMuseHooks(target, { quiet: true });
    const before = fs.readFileSync(hooksPath(target), 'utf8');
    const result = pruneMuseHooks(target, { dryRun: true, quiet: true });
    expect(result.pruned).toBe(1);
    expect(result.wrote).toBe(false);
    expect(fs.readFileSync(hooksPath(target), 'utf8')).toBe(before);
    expect(fs.existsSync(sidecarPath(target))).toBe(true);
  });

  it('is a no-op when no managed groups are installed', () => {
    const target = path.join(tmpRoot, 'project');
    writeHooks(target, JSON.stringify({ hooks: {} }));
    const result = pruneMuseHooks(target, { quiet: true });
    expect(result.pruned).toBe(0);
    expect(result.wrote).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCP profile merge semantics
// ---------------------------------------------------------------------------

describe('aiwgMcpServerProfile (#228)', () => {
  it('is a stdio server with mode optional (never aborts the run)', () => {
    const profile = aiwgMcpServerProfile();
    expect(profile.transport).toBe('stdio');
    expect(profile.command).toBe('aiwg');
    expect(profile.args).toEqual(['mcp', 'serve']);
    expect(profile.mode).toBe('optional');
    expect(profile.enabled).toBe(true);
  });
});

describe('mergeMcpProfile (#228)', () => {
  it('adds the aiwg server and bootstraps schema_version on a fresh doc', () => {
    const { doc, changed, plan } = mergeMcpProfile({});
    expect(changed).toBe(true);
    expect(doc.schema_version).toBe(1);
    expect(doc.mcp_servers.aiwg).toEqual(aiwgMcpServerProfile());
    expect(plan.join('\n')).toMatch(/schema_version/);
  });

  it('preserves unknown keys and existing servers', () => {
    const existing = {
      schema_version: 1,
      theme: 'dark',
      mcp_servers: {
        other: { transport: 'streamable_http', url: 'https://example.test/mcp', enabled: true, mode: 'optional' },
      },
    };
    const { doc, changed } = mergeMcpProfile(existing);
    expect(changed).toBe(true);
    expect(doc.theme).toBe('dark');
    expect(doc.mcp_servers.other).toEqual(existing.mcp_servers.other);
    expect(doc.mcp_servers.aiwg).toEqual(aiwgMcpServerProfile());
  });

  it('never downgrades an existing schema_version and warns on unknown ones', () => {
    const { doc, warnings } = mergeMcpProfile({ schema_version: 2 });
    expect(doc.schema_version).toBe(2);
    expect(warnings.join('\n')).toMatch(/schema_version/);
  });

  it('is a no-op when the canonical profile is already present', () => {
    const existing = { schema_version: 1, mcp_servers: { aiwg: aiwgMcpServerProfile() } };
    const { changed } = mergeMcpProfile(existing, { managed: true });
    expect(changed).toBe(false);
  });

  it('refreshes a drifted AIWG-recorded server when managed', () => {
    const drifted = { ...aiwgMcpServerProfile(), mode: 'required' };
    const { doc, changed, plan } = mergeMcpProfile(
      { schema_version: 1, mcp_servers: { aiwg: drifted } },
      { managed: true },
    );
    expect(changed).toBe(true);
    expect(doc.mcp_servers.aiwg).toEqual(aiwgMcpServerProfile());
    expect(plan.join('\n')).toMatch(/refresh/);
  });

  it('fails closed instead of overwriting an operator-owned aiwg key', () => {
    const operatorOwned = { transport: 'stdio', command: 'other-tool', args: [] };
    expect(() =>
      mergeMcpProfile({ schema_version: 1, mcp_servers: { aiwg: operatorOwned } }, { managed: false }),
    ).toThrow(/operator-owned/);
  });

  it('fails closed on a non-object mcp_servers field', () => {
    expect(() => mergeMcpProfile({ mcp_servers: ['nope'] })).toThrow(/must be an object/);
  });
});

// ---------------------------------------------------------------------------
// deployMuseMcp: filesystem behavior
// ---------------------------------------------------------------------------

describe('deployMuseMcp (#228)', () => {
  it('is a no-op without the explicit opt-in flag (zero writes)', () => {
    const result = deployMuseMcp({ dryRun: true, quiet: true, env: xdgEnv(), userHome: HOME });
    expect(result.skipped).toBe(true);
    expect(result.wrote).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'xdg'))).toBe(false);
  });

  it('dry-run shows the planned diff with zero writes', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      const result = deployMuseMcp({ dryRun: true, mcp: true, env: xdgEnv(), userHome: HOME });
      expect(result.changed).toBe(true);
      expect(result.wrote).toBe(false);
    } finally {
      console.log = origLog;
    }
    expect(fs.existsSync(path.join(tmpRoot, 'xdg'))).toBe(false);
    const out = logs.join('\n');
    expect(out).toContain('[dry-run]');
    expect(out).toContain('mcp_servers.aiwg');
    expect(out).toContain('zero writes');
  });

  it('creates settings.json with schema_version 1 and records the sidecar', () => {
    const result = deployMuseMcp({ mcp: true, quiet: true, env: xdgEnv(), userHome: HOME });
    expect(result.wrote).toBe(true);
    expect(result.backupPath).toBeNull();
    const doc = readJson(settingsPath());
    expect(doc.schema_version).toBe(1);
    expect(doc.mcp_servers.aiwg).toEqual(aiwgMcpServerProfile());
    const sidecar = readJson(path.join(tmpRoot, 'xdg', 'muse', MUSE_MCP_SIDECAR_NAME));
    expect(sidecar.servers).toEqual(['aiwg']);
  });

  it('backs up existing settings before writing and preserves unknown keys', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const existing = { schema_version: 1, approvals: 'strict', mcp_servers: { other: { transport: 'stdio', command: 'x', args: [] } } };
    fs.writeFileSync(settingsPath(), JSON.stringify(existing, null, 2), 'utf8');

    const result = deployMuseMcp({ mcp: true, quiet: true, env: xdgEnv(), userHome: HOME });
    expect(result.wrote).toBe(true);
    expect(result.backupPath).toMatch(/\.aiwg-backup-/);
    expect(readJson(result.backupPath as string)).toEqual(existing);

    const doc = readJson(settingsPath());
    expect(doc.approvals).toBe('strict');
    expect(doc.mcp_servers.other).toEqual(existing.mcp_servers.other);
    expect(doc.mcp_servers.aiwg).toEqual(aiwgMcpServerProfile());
  });

  it('is idempotent on a second run', () => {
    deployMuseMcp({ mcp: true, quiet: true, env: xdgEnv(), userHome: HOME });
    const second = deployMuseMcp({ mcp: true, quiet: true, env: xdgEnv(), userHome: HOME });
    expect(second.changed).toBe(false);
    expect(second.wrote).toBe(false);
  });

  it('never clobbers an operator-owned aiwg server key', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const operatorOwned = { schema_version: 1, mcp_servers: { aiwg: { transport: 'stdio', command: 'mine', args: [] } } };
    fs.writeFileSync(settingsPath(), JSON.stringify(operatorOwned), 'utf8');

    const result = deployMuseMcp({ mcp: true, quiet: true, env: xdgEnv(), userHome: HOME });
    expect(result.skipped).toBe(true);
    expect(result.wrote).toBe(false);
    expect((result.warnings || []).join('\n')).toMatch(/operator-owned/);
    expect(readJson(settingsPath())).toEqual(operatorOwned);
  });

  it('fails closed on unparseable settings.json with zero writes', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ broken', 'utf8');
    expect(() => deployMuseMcp({ mcp: true, quiet: true, env: xdgEnv(), userHome: HOME })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{ broken');
  });

  it('fails closed on bad XDG metadata', () => {
    expect(() =>
      deployMuseMcp({ mcp: true, quiet: true, env: { XDG_CONFIG_HOME: 'relative/path' }, userHome: HOME }),
    ).toThrow(/XDG_CONFIG_HOME/);
  });
});

describe('assertMuseUserSettingsPath (#228)', () => {
  it('resolves <xdg>/muse/settings.json next to the skills root', () => {
    expect(assertMuseUserSettingsPath({}, HOME)).toBe(path.join(HOME, '.config', 'muse', 'settings.json'));
    expect(assertMuseUserSettingsPath(xdgEnv(), HOME)).toBe(path.join(tmpRoot, 'xdg', 'muse', 'settings.json'));
  });

  it('never resolves into ~/.muse', () => {
    expect(assertMuseUserSettingsPath({}, HOME)).not.toContain(`${path.sep}.muse${path.sep}`);
  });
});

describe('pruneMuseMcp (#228)', () => {
  it('removes only the AIWG-managed server key, keeping operator servers', () => {
    deployMuseMcp({ mcp: true, quiet: true, env: xdgEnv(), userHome: HOME });
    const doc = readJson(settingsPath());
    doc.mcp_servers.other = { transport: 'stdio', command: 'x', args: [] };
    fs.writeFileSync(settingsPath(), JSON.stringify(doc, null, 2), 'utf8');

    const result = pruneMuseMcp({ quiet: true, env: xdgEnv(), userHome: HOME });
    expect(result.pruned).toBe(true);
    expect(result.wrote).toBe(true);
    const pruned = readJson(settingsPath());
    expect(pruned.mcp_servers.aiwg).toBeUndefined();
    expect(pruned.mcp_servers.other).toBeDefined();
    expect(fs.existsSync(path.join(tmpRoot, 'xdg', 'muse', MUSE_MCP_SIDECAR_NAME))).toBe(false);
  });

  it('dry-run prunes nothing', () => {
    deployMuseMcp({ mcp: true, quiet: true, env: xdgEnv(), userHome: HOME });
    const before = fs.readFileSync(settingsPath(), 'utf8');
    const result = pruneMuseMcp({ dryRun: true, quiet: true, env: xdgEnv(), userHome: HOME });
    expect(result.pruned).toBe(true);
    expect(result.wrote).toBe(false);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(before);
  });

  it('leaves an operator-owned aiwg key alone', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const operatorOwned = { schema_version: 1, mcp_servers: { aiwg: { transport: 'stdio', command: 'mine', args: [] } } };
    fs.writeFileSync(settingsPath(), JSON.stringify(operatorOwned), 'utf8');
    const result = pruneMuseMcp({ quiet: true, env: xdgEnv(), userHome: HOME });
    expect(result.pruned).toBe(false);
    expect(readJson(settingsPath())).toEqual(operatorOwned);
  });
});

// ---------------------------------------------------------------------------
// Writer wiring: defaults and flags
// ---------------------------------------------------------------------------

describe('muse writer hooks/MCP wiring (#228)', () => {
  it('postDeploy installs hooks by default on a full deploy', () => {
    const target = path.join(tmpRoot, 'full');
    fs.mkdirSync(target, { recursive: true });
    postDeploy(target, { quiet: true, srcRoot: repoRoot, dryRun: false });
    expect(fs.existsSync(hooksPath(target))).toBe(true);
    expect(readJson(hooksPath(target)).hooks.SessionStart).toHaveLength(1);
  });

  it('postDeploy skips hooks with hooks: false (--no-hooks)', () => {
    const target = path.join(tmpRoot, 'no-hooks');
    fs.mkdirSync(target, { recursive: true });
    postDeploy(target, { quiet: true, srcRoot: repoRoot, dryRun: false, hooks: false });
    expect(fs.existsSync(hooksPath(target))).toBe(false);
  });

  it('postDeploy does not touch MCP settings by default', () => {
    const target = path.join(tmpRoot, 'no-mcp');
    fs.mkdirSync(target, { recursive: true });
    postDeploy(target, {
      quiet: true,
      srcRoot: repoRoot,
      dryRun: false,
      env: xdgEnv(),
      userHome: HOME,
    });
    expect(fs.existsSync(path.join(tmpRoot, 'xdg'))).toBe(false);
  });

  it('postDeploy merges the MCP profile only with mcp: true (--mcp)', () => {
    const target = path.join(tmpRoot, 'with-mcp');
    fs.mkdirSync(target, { recursive: true });
    postDeploy(target, {
      quiet: true,
      srcRoot: repoRoot,
      dryRun: false,
      mcp: true,
      env: xdgEnv(),
      userHome: HOME,
    });
    const doc = readJson(settingsPath());
    expect(doc.mcp_servers.aiwg).toEqual(aiwgMcpServerProfile());
  });

  it('dry-run postDeploy performs zero writes for hooks and MCP', () => {
    const target = path.join(tmpRoot, 'dry');
    fs.mkdirSync(target, { recursive: true });
    postDeploy(target, {
      quiet: true,
      srcRoot: repoRoot,
      dryRun: true,
      mcp: true,
      env: xdgEnv(),
      userHome: HOME,
    });
    expect(fs.existsSync(hooksPath(target))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'xdg'))).toBe(false);
  });
});
