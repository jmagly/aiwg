// Verify the prompt discovery hook extends the existing managed settings owner.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAiwgHooks } from '../../../src/extensions/claude-hooks-installer.js';

const frameworkRoot = fileURLToPath(new URL('../../../', import.meta.url));
let projectPath: string;
beforeEach(async () => { projectPath = await mkdtemp(path.join(tmpdir(), 'aiwg-prompt-install-')); });
afterEach(async () => { await rm(projectPath, { recursive: true, force: true }); });

it('deploys and registers prompt discovery idempotently alongside operator hooks', async () => {
  const settingsPath = path.join(projectPath, '.claude/settings.json');
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const operator = { hooks: [{ type: 'command', command: 'echo operator' }] };
  await writeFile(settingsPath, JSON.stringify({ hooks: { UserPromptSubmit: [operator] } }));
  const first = await installAiwgHooks({ projectPath, frameworkRoot });
  expect(first?.registeredEvents).toContain('UserPromptSubmit → aiwg-prompt-discovery');
  expect(await readFile(path.join(projectPath, '.claude/hooks/aiwg-prompt-discovery.cjs'), 'utf8'))
    .toContain('additionalContext');
  const once = await readFile(settingsPath, 'utf8');
  const second = await installAiwgHooks({ projectPath, frameworkRoot });
  expect(second?.registeredEvents).toEqual([]);
  expect(await readFile(settingsPath, 'utf8')).toBe(once);
  const groups = JSON.parse(once).hooks.UserPromptSubmit;
  expect(groups).toContainEqual(operator);
  expect(groups.flatMap((g: { hooks: unknown[] }) => g.hooks)).toContainEqual({
    type: 'command', command: 'node .claude/hooks/aiwg-prompt-discovery.cjs',
    _aiwg_managed: true, _aiwg_id: 'aiwg-prompt-discovery',
  });
  expect(groups).toHaveLength(2);
});
