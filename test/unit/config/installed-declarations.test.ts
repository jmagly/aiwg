// Pending declarations must be distinct from incomplete historical records.
import { expect, it } from 'vitest';
import os from 'node:os';
import { withInstalledSelection, permitsBundleDeployment } from '../../../src/config/installed-selection.js';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { validateInstalled } from '../../../src/config/installed-validation.js';
import { emptyConfig, getDeploymentSummary, updateInstalled } from '../../../src/config/aiwg-config.js';
const schema = JSON.parse(fs.readFileSync(path.resolve('vscode-extension/schemas/aiwg.config.v1.json'), 'utf8'));
const ajv = new Ajv({ strict: true }); addFormats(ajv);
const validate = ajv.compile(schema.definitions.InstalledFramework);
it.each([
  { deployedTo: { flue: {} } },
  { deployedTo: { flue: { copy: true }, claude: { copy: false } } },
  { version: '1', source: 'bundled', installedAt: '2026-10-31T00:00:00Z', deployedTo: { flue: {}, codex: { agents: 0, commands: 0, skills: 3, rules: 0 } } },
])('accepts pending declarations and mixed pending/deployed providers: %j', entry => {
  expect(() => validateInstalled({ sdlc: entry })).not.toThrow();
  expect(validate(entry), JSON.stringify(validate.errors)).toBe(true);
});
it.each([
  { deployedTo: { flue: { copy: 'yes' } } },
  { deployedTo: { flue: { copy: true, skills: 2 } } },
  { deployedTo: { flue: { skills: 2 } } },
  { source: 'bundled', deployedTo: { flue: {} } },
  { deployedTo: { flue: { agents: 0, commands: 0, skills: 2, rules: 0 } } },
  { deployedTo: { flue: { agents: 0, commands: 0, skills: -1, rules: 0 } } },
])('rejects incomplete records in both loader and schema: %j', entry => {
  expect(() => validateInstalled({ sdlc: entry })).toThrow();
  expect(validate(entry)).toBe(false);
});
it('fills a pending record without losing its other provider declarations', () => {
  const config = emptyConfig(['flue']);
  config.installed.sdlc = { deployedTo: { flue: {}, codex: {} } };
  expect(getDeploymentSummary(config, 'flue')).toEqual({ agents: 0, commands: 0, skills: 0, rules: 0 });
  updateInstalled(config, 'sdlc', 'flue', { agents: 0, commands: 0, skills: 116, rules: 2 }, { version: '1', source: 'bundled' });
  expect(config.installed.sdlc).toMatchObject({ version: '1', source: 'bundled', deployedTo: { codex: {}, flue: { skills: 116 } } });
  expect(typeof config.installed.sdlc.installedAt).toBe('string');
  expect(() => validateInstalled(config.installed)).not.toThrow();
});

it('limits automatic local passes to the bundle’s declared providers while preserving manual use', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-selection-mode-'));
  try {
    expect(permitsBundleDeployment(project, 'dropped', 'claude')).toBe(true);
    await withInstalledSelection(project, { sdlc: { deployedTo: { claude: {} } } }, async () => {
      expect(permitsBundleDeployment(project, 'sdlc-complete', 'claude')).toBe(true);
      expect(permitsBundleDeployment(project, 'sdlc', 'codex')).toBe(false);
      expect(permitsBundleDeployment(project, 'dropped', 'claude')).toBe(false);
    });
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
