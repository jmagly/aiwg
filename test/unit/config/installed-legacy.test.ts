// Existing installed records remain loadable; only new deployment writes are strict.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { emptyConfig, readAiwgConfig, updateInstalled, type DeployedArtifactCounts } from '../../../src/config/aiwg-config.js';
let project: string;
beforeEach(async () => { project = await fs.mkdtemp(path.join(os.tmpdir(), 'installed-legacy-')); });
afterEach(async () => { await fs.rm(project, { recursive: true, force: true }); });
it.each([
  { deployedTo: { claude: {} } },
  { deployedTo: { claude: { skills: 29 } } },
  { deployedTo: { codex: { agents: 0 } } },
  { deployedTo: { codex: { agents: 0, commands: 0, skills: 0, rules: 0 } } },
  { version: '1', source: 'bundled' },
  { deployedTo: { codex: { skills: -1 } } },
  { version: '1', source: 'bundled', deployedTo: {} },
  { version: '1', source: 'project-local', installedAt: '', localPath: 'bundle', deployedTo: {} },
  { version: '1', deployedTo: { claude: { skills: 0, custom: 'legacy metadata' } } },
])('loads legacy installed entry without rewriting it: %j', async entry => {
  const config = { version: '1', providers: ['claude'], scripts: {}, installed: { fixture: entry } };
  await fs.mkdir(path.join(project, '.aiwg'));
  const file = path.join(project, '.aiwg/aiwg.config');
  const bytes = JSON.stringify(config);
  await fs.writeFile(file, bytes);
  expect((await readAiwgConfig(project))?.installed.fixture).toEqual(entry);
  expect(await fs.readFile(file, 'utf8')).toBe(bytes);
});
it.each([{}, { skills: 0 }, { agents: 0, commands: 0, skills: -1, rules: 0 }])('rejects invalid new counts before mutating a legacy record: %j', counts => {
  const config = emptyConfig(['claude']);
  config.installed.fixture = { deployedTo: { claude: { skills: 29 } } };
  const before = structuredClone(config);
  expect(() => updateInstalled(config, 'fixture', 'codex', counts as DeployedArtifactCounts, { version: '1', source: 'bundled' })).toThrow(/four nonnegative/);
  expect(config).toEqual(before);
  updateInstalled(config, 'fixture', 'codex', { agents: 0, commands: 0, skills: 0, rules: 0 }, { version: '1', source: 'bundled' });
  expect(config.installed.fixture.deployedTo.claude).toEqual({ skills: 29 });
});
