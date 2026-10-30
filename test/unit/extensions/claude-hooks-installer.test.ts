/**
 * Tests for the Claude Code aiwg-hooks installer (PUW-010 / #1111).
 *
 * Schema notes (#107): Claude Code requires `hooks` to be an object
 * keyed by event name, each value an array of `{ matcher?, hooks }`
 * groups. Earlier AIWG builds wrote an array-of-matchers; those are
 * migrated to object shape on read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  installAiwgHooks,
  restoreSettingsBackup,
} from '../../../src/extensions/claude-hooks-installer.js';

let tmpRoot: string;
let projectPath: string;
let frameworkRoot: string;

interface HookEntry {
  type: string;
  command: string;
  _aiwg_managed?: boolean;
  _aiwg_id?: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
type HooksField = Record<string, HookGroup[]>;

async function makeAddonHooks(root: string): Promise<void> {
  const dir = path.join(root, 'agentic', 'code', 'addons', 'aiwg-hooks', 'hooks');
  await fs.mkdir(dir, { recursive: true });
  for (const file of ['aiwg-permissions.cjs', 'aiwg-session.cjs', 'aiwg-trace.cjs']) {
    await fs.writeFile(path.join(dir, file), '#!/usr/bin/env node\n', 'utf8');
  }
}

async function readSettings(): Promise<{ hooks?: HooksField; [k: string]: unknown }> {
  return JSON.parse(
    await fs.readFile(path.join(projectPath, '.claude', 'settings.json'), 'utf8'),
  );
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-claude-hooks-'));
  projectPath = path.join(tmpRoot, 'project');
  frameworkRoot = path.join(tmpRoot, 'framework');
  await fs.mkdir(projectPath, { recursive: true });
  await makeAddonHooks(frameworkRoot);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('installAiwgHooks', () => {
  it('returns null when addon source is missing', async () => {
    const r = await installAiwgHooks({
      projectPath,
      frameworkRoot: path.join(tmpRoot, 'no-such-framework'),
    });
    expect(r).toBeNull();
  });

  it('copies hook scripts to .claude/hooks/', async () => {
    const r = await installAiwgHooks({ projectPath, frameworkRoot });
    expect(r).not.toBeNull();
    const claudeHooksDir = path.join(projectPath, '.claude', 'hooks');
    const installed = await fs.readdir(claudeHooksDir);
    expect(installed).toContain('aiwg-permissions.cjs');
    expect(installed).toContain('aiwg-session.cjs');
    expect(installed).toContain('aiwg-trace.cjs');
  });

  it('writes settings.json with hooks as an object keyed by event name (#107)', async () => {
    const r = await installAiwgHooks({ projectPath, frameworkRoot });
    expect(r).not.toBeNull();
    const settings = await readSettings();

    // Schema: hooks must be a plain object, not an array.
    expect(settings.hooks).toBeDefined();
    expect(Array.isArray(settings.hooks)).toBe(false);
    expect(typeof settings.hooks).toBe('object');

    const hooks = settings.hooks as HooksField;
    expect(Object.keys(hooks).sort()).toEqual(
      ['PermissionRequest', 'SessionStart', 'SubagentStart', 'SubagentStop'],
    );

    // Each event holds an array of groups; each group has a hooks array
    // with the AIWG-managed entry.
    for (const [event, groups] of Object.entries(hooks)) {
      expect(Array.isArray(groups)).toBe(true);
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) {
        expect(Array.isArray(g.hooks)).toBe(true);
        for (const h of g.hooks) {
          expect(h._aiwg_managed).toBe(true);
          expect(typeof h._aiwg_id).toBe('string');
          expect(h.type).toBe('command');
          expect(h.command).toMatch(/^node \.claude\/hooks\/aiwg-/);
          expect(h.command).not.toContain('\\');
        }
      }
      void event;
    }

    const commandFor = (event: string, hookId: string): string | undefined =>
      hooks[event]
        ?.flatMap((group) => group.hooks)
        .find((hook) => hook._aiwg_id === hookId)?.command;
    expect(commandFor('SubagentStart', 'aiwg-trace')).toBe(
      'node .claude/hooks/aiwg-trace.cjs start',
    );
    expect(commandFor('SubagentStop', 'aiwg-trace')).toBe(
      'node .claude/hooks/aiwg-trace.cjs stop',
    );
  });

  it('preserves operator-authored entries when merging (object shape)', async () => {
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            PermissionRequest: [
              { hooks: [{ type: 'command', command: 'operator-script.sh' }] },
            ],
          },
          customField: 'preserved',
        },
        null,
        2,
      ),
      'utf8',
    );
    const r = await installAiwgHooks({ projectPath, frameworkRoot });
    expect(r?.backupPath).toBeDefined(); // backup created since no AIWG marker existed
    const settings = await readSettings();
    expect(settings.customField).toBe('preserved');
    const permGroups = settings.hooks?.PermissionRequest ?? [];
    // Operator group plus AIWG group
    expect(permGroups).toHaveLength(2);
    const operatorGroup = permGroups.find((g) =>
      g.hooks.some((h) => h.command === 'operator-script.sh'),
    );
    expect(operatorGroup).toBeDefined();
    const aiwgGroup = permGroups.find((g) =>
      g.hooks.some((h) => h._aiwg_managed === true),
    );
    expect(aiwgGroup).toBeDefined();
  });

  it('migrates legacy array-shaped hooks field to object shape (#107)', async () => {
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    // Pre-write a settings.json in the old broken array shape
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: [
            {
              matcher: 'PermissionRequest',
              hooks: [{ type: 'command', command: 'operator-script.sh' }],
            },
          ],
          customField: 'preserved',
        },
        null,
        2,
      ),
      'utf8',
    );
    const r = await installAiwgHooks({ projectPath, frameworkRoot });
    expect(r?.migratedFromLegacy).toBe(true);

    const settings = await readSettings();
    expect(settings.customField).toBe('preserved');
    expect(Array.isArray(settings.hooks)).toBe(false);
    expect(typeof settings.hooks).toBe('object');

    const permGroups = settings.hooks?.PermissionRequest ?? [];
    // Operator entry preserved + AIWG entry added
    const allHandlers = permGroups.flatMap((g) => g.hooks);
    expect(allHandlers.some((h) => h.command === 'operator-script.sh')).toBe(true);
    expect(
      allHandlers.some((h) => h._aiwg_managed === true && h._aiwg_id === 'aiwg-permissions'),
    ).toBe(true);
  });

  it('is idempotent — re-running does not duplicate entries', async () => {
    await installAiwgHooks({ projectPath, frameworkRoot });
    await installAiwgHooks({ projectPath, frameworkRoot });
    const settings = await readSettings();
    const permGroups = settings.hooks?.PermissionRequest ?? [];
    // Single AIWG-managed group with one handler
    const aiwgHandlers = permGroups
      .flatMap((g) => g.hooks)
      .filter((h) => h._aiwg_id === 'aiwg-permissions');
    expect(aiwgHandlers).toHaveLength(1);
  });

  it('dry-run does not write files', async () => {
    const r = await installAiwgHooks({ projectPath, frameworkRoot, dryRun: true });
    expect(r).not.toBeNull();
    await expect(fs.access(path.join(projectPath, '.claude', 'settings.json'))).rejects.toThrow();
  });

  it('skips backup when settings already has AIWG marker (object shape)', async () => {
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PermissionRequest: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'old-aiwg.js',
                  _aiwg_managed: true,
                  _aiwg_id: 'aiwg-permissions',
                },
              ],
            },
          ],
        },
      }, null, 2),
      'utf8',
    );
    const r = await installAiwgHooks({ projectPath, frameworkRoot });
    expect(r?.backupPath).toBeUndefined();
  });

  it('skips backup when legacy-shaped settings still carries AIWG marker', async () => {
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: [
          {
            matcher: 'PermissionRequest',
            hooks: [
              {
                type: 'command',
                command: 'old-aiwg.js',
                _aiwg_managed: true,
                _aiwg_id: 'aiwg-permissions',
              },
            ],
          },
        ],
      }, null, 2),
      'utf8',
    );
    const r = await installAiwgHooks({ projectPath, frameworkRoot });
    // AIWG marker recognized in legacy form → no backup, but migration still runs
    expect(r?.backupPath).toBeUndefined();
    expect(r?.migratedFromLegacy).toBe(true);
  });

  it('adopts a pre-existing untagged entry instead of registering the hook twice (#2543)', async () => {
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    // An operator (or an older AIWG) already wired the same script, untagged.
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'node .claude/hooks/aiwg-session.cjs' }] },
          ],
        },
      }),
      'utf8',
    );

    await installAiwgHooks({ projectPath, frameworkRoot });
    const settings = await readSettings();
    const sessionEntries = (settings.hooks?.SessionStart ?? [])
      .flatMap((group) => group.hooks ?? [])
      .filter((entry) => entry.command.includes('aiwg-session'));

    expect(sessionEntries).toHaveLength(1);
    expect(sessionEntries[0]._aiwg_managed).toBe(true);
    expect(sessionEntries[0]._aiwg_id).toBe('aiwg-session');
  });

  it('does not back up a settings.json AIWG created itself (#2542)', async () => {
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    // Exactly what tools/agents/providers/claude.mjs writes on a greenfield deploy.
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ version: '1.0', created: new Date().toISOString(), aiwg: { enabled: true, mode: 'all' } }),
      'utf8',
    );

    const r = await installAiwgHooks({ projectPath, frameworkRoot });
    expect(r?.backupPath).toBeUndefined();
    const entries = await fs.readdir(claudeDir);
    expect(entries.filter((name) => name.includes('.bak.'))).toHaveLength(0);
  });

  it('still backs up genuinely operator-authored settings (#2542)', async () => {
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ env: { OPERATOR: 'yes' } }),
      'utf8',
    );

    const r = await installAiwgHooks({ projectPath, frameworkRoot });
    expect(r?.backupPath).toBeDefined();
    const entries = await fs.readdir(claudeDir);
    expect(entries.filter((name) => name.includes('.bak.')).length).toBeGreaterThan(0);
  });
});

describe('restoreSettingsBackup', () => {
  it('returns null when no backup exists', async () => {
    const r = await restoreSettingsBackup(projectPath);
    expect(r).toBeNull();
  });

  it('restores the latest backup', async () => {
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json.bak.2026-01-01T00-00-00-000Z'),
      JSON.stringify({ marker: 'older' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(claudeDir, 'settings.json.bak.2026-05-06T01-00-00-000Z'),
      JSON.stringify({ marker: 'newer' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ marker: 'current' }),
      'utf8',
    );
    const restored = await restoreSettingsBackup(projectPath);
    expect(restored).toContain('2026-05-06T01-00-00-000Z');
    const final = JSON.parse(
      await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8'),
    );
    expect(final.marker).toBe('newer');
  });
});

describe('Claude attribution defaults (#3750)', () => {
  const defaults = { commit: '', pr: '', sessionUrl: false };
  async function seed(settings: object) {
    await fs.mkdir(path.join(projectPath, '.claude'), { recursive: true });
    await fs.writeFile(path.join(projectPath, '.claude/settings.json'), JSON.stringify(settings));
  }
  it('fills fresh settings and records ownership outside attribution', async () => {
    await installAiwgHooks({ projectPath, frameworkRoot });
    const settings = await readSettings();
    expect(settings.attribution).toEqual(defaults);
    expect(settings.aiwg).toEqual({ attributionKeys: ['commit', 'pr', 'sessionUrl'] });
    expect(settings).not.toHaveProperty('includeCoAuthoredBy');
  });
  it('does not claim existing empty operator values', async () => {
    await seed({ attribution: { commit: '', pr: '' }, aiwg: { enabled: true } });
    await installAiwgHooks({ projectPath, frameworkRoot });
    const settings = await readSettings();
    expect(settings.attribution).toEqual(defaults);
    expect(settings.aiwg).toEqual({ enabled: true, attributionKeys: ['sessionUrl'] });
  });
  it('keeps operator strings and session preference with warnings', async () => {
    const attribution = { commit: 'Human commit', pr: 'Human PR', sessionUrl: true };
    await seed({ attribution });
    const result = await installAiwgHooks({ projectPath, frameworkRoot });
    expect((await readSettings()).attribution).toEqual(attribution);
    expect(result?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Preserved operator attribution.commit'),
      expect.stringContaining('Preserved operator attribution.pr'),
    ]));
  });
  it.each([undefined, { commit: 'Keep me' }, false])('opt-out leaves attribution %j untouched', async attribution => {
    await seed({ attribution });
    await installAiwgHooks({ projectPath, frameworkRoot, attribution: false });
    expect((await readSettings()).attribution).toEqual(attribution);
    expect((await readSettings()).aiwg).toBeUndefined();
  });
  it('dry-run leaves an unmarked file and backups untouched', async () => {
    await seed({ env: { OPERATOR: 'yes' } });
    const before = await fs.readFile(path.join(projectPath, '.claude/settings.json'), 'utf8');
    await installAiwgHooks({ projectPath, frameworkRoot, dryRun: true });
    expect(await fs.readFile(path.join(projectPath, '.claude/settings.json'), 'utf8')).toBe(before);
    expect(await fs.readdir(path.join(projectPath, '.claude'))).toEqual(['settings.json']);
  });
  it('does not change operator settings when backup fails', async () => {
    await seed({ attribution: { commit: 'Keep' } });
    vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('synthetic backup failure'));
    await expect(installAiwgHooks({ projectPath, frameworkRoot, hooks: false })).rejects.toThrow('Backup failed');
    expect(await readSettings()).toEqual({ attribution: { commit: 'Keep' } });
  });
  it('backs up operator bytes and shares only settings the installer writes', async () => {
    await seed({ operator: true });
    const before = await fs.readFile(path.join(projectPath, '.claude/settings.json'));
    const first = await installAiwgHooks({ projectPath, frameworkRoot, hooks: false, frameworkSlug: 'sdlc-complete' });
    expect(await fs.readFile(first!.backupPath!)).toEqual(before);
    await installAiwgHooks({ projectPath, frameworkRoot, hooks: false, frameworkSlug: 'media-marketing-kit' });
    await installAiwgHooks({ projectPath, frameworkRoot, hooks: false });
    const record = JSON.parse(await fs.readFile(path.join(projectPath, '.claude/.aiwg-manifest.json'), 'utf8')).managed['settings.json'];
    expect(record.settingsPreimage.bytes).toBe(before.toString('base64'));
    expect((await readSettings()).aiwg).not.toHaveProperty('mode');
    expect(record.settings['/aiwg/mode']).toBeUndefined();
    expect(record.settings['/attribution/pr'].owners).toEqual(['media-marketing-kit', 'sdlc-complete']);
  });
  it('re-runs idempotently with one backup of the unmarked original', async () => {
    await seed({ attribution: { commit: '' }, env: { KEEP: 'yes' } });
    const first = await installAiwgHooks({ projectPath, frameworkRoot });
    expect(JSON.parse(await fs.readFile(first!.backupPath!, 'utf8'))).toEqual({ attribution: { commit: '' }, env: { KEEP: 'yes' } });
    const before = await fs.readFile(path.join(projectPath, '.claude/settings.json'), 'utf8');
    const second = await installAiwgHooks({ projectPath, frameworkRoot });
    expect(await fs.readFile(path.join(projectPath, '.claude/settings.json'), 'utf8')).toBe(before);
    expect(second?.backupPath).toBeUndefined();
  });
  it('applies without addon hooks and preserves later edits on remove', async () => {
    const { removeClaudeAttribution } = await import('../../../src/extensions/claude-hooks-installer.js');
    await installAiwgHooks({ projectPath, frameworkRoot: '/missing', hooks: false });
    const settings = await readSettings();
    expect(settings.attribution).toEqual(defaults);
    expect(settings.hooks).toBeUndefined();
    await seed({ ...settings, attribution: { ...defaults, pr: 'Later edit', extra: 'Keep' }, other: 42 });
    await removeClaudeAttribution(projectPath, true);
    expect((await readSettings()).attribution).toEqual({ ...defaults, pr: 'Later edit', extra: 'Keep' });
    await removeClaudeAttribution(projectPath);
    expect(await readSettings()).toEqual({ attribution: { pr: 'Later edit', extra: 'Keep' }, other: 42 });
  });
  it('restore preserves existing empty keys and later operator attribution', async () => {
    await seed({ attribution: { commit: '' }, operator: true });
    await installAiwgHooks({ projectPath, frameworkRoot });
    const settings = await readSettings();
    await seed({ ...settings, attribution: { ...defaults, pr: 'Later edit' } });
    await restoreSettingsBackup(projectPath);
    expect(await readSettings()).toEqual({ attribution: { commit: '', pr: 'Later edit' }, operator: true });
  });
  it('restores original operator attribution when the settings file is missing', async () => {
    await seed({ attribution: { commit: 'Original' } });
    await installAiwgHooks({ projectPath, frameworkRoot });
    await fs.unlink(path.join(projectPath, '.claude/settings.json'));
    await restoreSettingsBackup(projectPath);
    expect(await readSettings()).toEqual({ attribution: { commit: 'Original' } });
  });
  it.each(['{invalid', 'null'])('restores a valid backup when current settings are corrupt: %s', async raw => {
    await seed({ attribution: { commit: 'Original' } });
    await installAiwgHooks({ projectPath, frameworkRoot });
    await fs.writeFile(path.join(projectPath, '.claude/settings.json'), raw);
    await restoreSettingsBackup(projectPath);
    expect(await readSettings()).toEqual({ attribution: { commit: 'Original' } });
  });
  it('restore undoes owned keys even when a fresh install has no backup', async () => {
    await installAiwgHooks({ projectPath, frameworkRoot });
    await restoreSettingsBackup(projectPath);
    expect((await readSettings()).attribution).toBeUndefined();
  });
});
