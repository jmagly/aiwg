/**
 * Tests for the Claude Code aiwg-hooks installer (PUW-010 / #1111).
 *
 * Schema notes (#107): Claude Code requires `hooks` to be an object
 * keyed by event name, each value an array of `{ matcher?, hooks }`
 * groups. Earlier AIWG builds wrote an array-of-matchers; those are
 * migrated to object shape on read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  installAiwgHooks,
  managedClaudeHooks,
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

function expectedCommand(event: string) {
  return managedClaudeHooks(['aiwg-session.cjs', 'aiwg-permissions.cjs', 'aiwg-trace.cjs'], projectPath,
    path.join(frameworkRoot, 'agentic/code/addons/aiwg-hooks/hooks')).find(hook => hook.event === event)!.command;
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

describe('Claude hook upgrades', () => {
  it('refreshes stale pre-.cjs hook command paths (regression: SessionStart MODULE_NOT_FOUND)', async () => {
    // User installed AIWG before be3ee551 renamed hook scripts from .js to
    // .cjs. After a later refresh, only .cjs files exist on disk, but
    // settings.json still references the .js paths — every hook
    // invocation crashes at `node:internal/modules/cjs/loader` with
    // MODULE_NOT_FOUND. The installer must update stale AIWG-managed
    // commands rather than skip them via the idempotency check.
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node .claude/hooks/aiwg-session.js',
                  _aiwg_managed: true,
                  _aiwg_id: 'aiwg-session',
                },
              ],
            },
          ],
          PermissionRequest: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node .claude/hooks/aiwg-permissions.js',
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

    const result = await installAiwgHooks({ projectPath, frameworkRoot });
    const settings = await readSettings();
    const sessionHooks = (settings.hooks?.SessionStart ?? []).flatMap((g) => g.hooks);
    const sessionEntry = sessionHooks.find((h) => h._aiwg_id === 'aiwg-session');
    expect(sessionEntry?.command).toContain('aiwg-session.cjs');
    expect(sessionEntry?.command).not.toContain('aiwg-session.js"');

    const permHooks = (settings.hooks?.PermissionRequest ?? []).flatMap((g) => g.hooks);
    const permEntry = permHooks.find((h) => h._aiwg_id === 'aiwg-permissions');
    expect(permEntry?.command).toContain('aiwg-permissions.cjs');

    // Should not duplicate — exactly one entry per event.
    expect(sessionHooks.filter((h) => h._aiwg_id === 'aiwg-session')).toHaveLength(1);
    expect(permHooks.filter((h) => h._aiwg_id === 'aiwg-permissions')).toHaveLength(1);

    // And it should surface the refresh in warnings so refresh CLI users
    // see what changed.
    expect(result?.warnings.some((w) => w.includes('Refreshed stale'))).toBe(true);
  });

  it('refreshes Windows backslash hook commands to shell-safe forward slashes (#133)', async () => {
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node .claude\\hooks\\aiwg-session.cjs',
                  _aiwg_managed: true,
                  _aiwg_id: 'aiwg-session',
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    );

    const result = await installAiwgHooks({ projectPath, frameworkRoot });
    const settings = await readSettings();
    const sessionEntry = (settings.hooks?.SessionStart ?? [])
      .flatMap((group) => group.hooks)
      .find((hook) => hook._aiwg_id === 'aiwg-session');

    expect(sessionEntry?.command).toBe(expectedCommand('SessionStart'));
    expect(result?.warnings).toContain(
      'Refreshed stale SessionStart → aiwg-session command path',
    );
  });

  it('refreshes trace hooks missing their event-specific subcommands (#134)', async () => {
    const claudeDir = path.join(projectPath, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: Object.fromEntries(
          ['SubagentStart', 'SubagentStop'].map((event) => [
            event,
            [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'node .claude/hooks/aiwg-trace.cjs',
                    _aiwg_managed: true,
                    _aiwg_id: 'aiwg-trace',
                  },
                ],
              },
            ],
          ]),
        ),
      }),
      'utf8',
    );

    const result = await installAiwgHooks({ projectPath, frameworkRoot });
    const settings = await readSettings();
    const traceCommand = (event: string): string | undefined =>
      settings.hooks?.[event]
        ?.flatMap((group) => group.hooks)
        .find((hook) => hook._aiwg_id === 'aiwg-trace')?.command;

    expect(traceCommand('SubagentStart')).toBe(
      expectedCommand('SubagentStart'),
    );
    expect(traceCommand('SubagentStop')).toBe(
      expectedCommand('SubagentStop'),
    );
    expect(
      result?.warnings.filter((warning) => warning.includes('Refreshed stale')),
    ).toHaveLength(2);
  });

});
