// Existing Desktop deployments retain copy intent and bundle history after the public ID rename.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAiwgConfig } from '../../../src/config/aiwg-config.js';
import { normalizeAiwgConfigCandidate } from '../../../src/config/config-normalization.js';
import { providerCopyMode } from '../../../src/providers/deployment-preservation.mjs';
import { bundleDeploymentHistory, bundleCopyArgs, projectLocalCopyMode, markBundleReconciled } from '../../../src/cli/handlers/bundle-deployment-mode.js';

let root: string;
const counts = { agents: 0, commands: 0, skills: 1, rules: 0, copy: true };
const config = () => ({ version: '1', providers: ['windsurf'], installed: { sdlc: { version: '1', installedAt: '2026-01-01', deployedTo: { windsurf: counts } } }, scripts: {} });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aiwg-devin-legacy-records-')); await mkdir(join(root, '.aiwg')); });
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('legacy Desktop deployment metadata', () => {
  it('reads legacy configured and deployed IDs as Devin without rewriting the file', async () => {
    const file = join(root, '.aiwg/aiwg.config');
    const bytes = JSON.stringify(config());
    await writeFile(file, bytes);
    const result = await readAiwgConfig(root);
    expect(result?.providers).toEqual(['devin']);
    expect(result?.installed.sdlc.deployedTo.devin).toEqual(counts);
    expect(result?.installed.sdlc.deployedTo).not.toHaveProperty('windsurf');
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });
  it('keeps copy intent from legacy config when pruning as Devin', () => {
    expect(providerCopyMode(root, 'devin', 'sdlc', config())).toBe(true);
  });
  it('keeps legacy receipt history, including inherited copy intent', async () => {
    await writeFile(join(root, '.aiwg/.aiwg-manifest.json'), JSON.stringify({ bundleDeployments: {
      windsurf: { sdlc: { copy: true, produces: ['child'] } },
    } }));
    expect(providerCopyMode(root, 'devin', 'sdlc')).toBe(true);
    expect(providerCopyMode(root, 'devin', 'child')).toBe(true);
    expect(bundleDeploymentHistory(root)).toMatchObject({ devin: { sdlc: { copy: true } } });
  });
  it('combines old and current history while current records take precedence', async () => {
    await writeFile(join(root, '.aiwg/.aiwg-manifest.json'), JSON.stringify({ bundleDeployments: {
      windsurf: { sdlc: { copy: true }, utils: { copy: true } },
      devin: { sdlc: { copy: false } },
    } }));
    expect(bundleDeploymentHistory(root)).toEqual({ devin: { sdlc: { copy: false }, utils: { copy: true } } });
  });
  it('retains copy flags for raw legacy deployment records', () => {
    expect(bundleCopyArgs(config().installed, 'sdlc', 'devin')).toEqual(['--copy-all']);
    expect(projectLocalCopyMode(config(), 'sdlc', 'devin', [], false)).toBe(true);
  });
  it('updates a legacy receipt through the canonical provider ID', async () => {
    const file = join(root, '.aiwg/.aiwg-manifest.json');
    await writeFile(file, JSON.stringify({ bundleDeployments: { windsurf: { 'sdlc-complete': { copy: true } } } }));
    markBundleReconciled(root, 'sdlc', 'devin');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored.bundleDeployments.devin['sdlc-complete'].reconciled).toBe(true);
    expect(stored.bundleDeployments).not.toHaveProperty('windsurf');
  });
  it('deduplicates selectors while preserving other provider records', () => {
    const candidate = { ...config(), providers: ['windsurf', 'claude', 'devin'], installed: {
      sdlc: { version: '1', installedAt: '2026-01-01', deployedTo: { windsurf: counts, devin: { ...counts, copy: false }, claude: counts } },
    } };
    const result = normalizeAiwgConfigCandidate(candidate);
    expect(result.providers).toEqual(['devin', 'claude']);
    expect(result.installed.sdlc.deployedTo).toEqual({ devin: { ...counts, copy: false }, claude: counts });
  });
});
