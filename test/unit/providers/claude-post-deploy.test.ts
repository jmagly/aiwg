// Preserve historical Claude settings writes and receipt the creation preimage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postDeploy } from '../../../tools/agents/providers/claude-post-deploy.mjs';
import { planDeploymentRemoval } from '../../../src/providers/deployment-removal.js';
import { applyRemovalTransaction } from '../../../src/providers/removal-transaction.js';

let root: string;
const file = () => path.join(root, '.claude/settings.json');
const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
const deploy = (attribution: boolean, mode = 'sdlc') => postDeploy(root, {
  attribution, mode, contextFiles: false, frameworkSlug: 'sdlc-complete', writtenFiles: [],
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-claude-post-'));
  vi.stubEnv('AIWG_CONFIG', path.join(root, 'user-config'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('Claude settings creation compatibility', () => {
  it.each([false, true])('does not add or replace mode in existing settings (attribution: %s)', async attribution => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    for (const settings of [{ operator: true }, { aiwg: { mode: 'operator' }, operator: true }]) {
      const original = JSON.stringify(settings, null, '\t') + '\n';
      fs.writeFileSync(file(), original);
      await deploy(attribution);
      expect(read().aiwg?.mode).toBe('aiwg' in settings ? 'operator' : undefined);
      if (!attribution) {
        expect(fs.readFileSync(file(), 'utf8')).toBe(original);
        expect(fs.existsSync(path.join(root, '.claude/.aiwg-manifest.json'))).toBe(false);
      }
    }
  });
  it.each([false, true])('records creation so removal restores absence or later operator keys (attribution: %s)', async attribution => {
    for (const edited of [false, true]) {
      await deploy(attribution);
      expect(read().aiwg.mode).toBe('sdlc');
      const receipt = JSON.parse(fs.readFileSync(path.join(root, '.claude/.aiwg-manifest.json'), 'utf8'));
      expect(receipt.managed['settings.json'].settingsPreimage).toEqual({ present: false });
      expect(receipt.managed['settings.json'].settings['/aiwg/mode'].previous).toEqual({ present: false });
      if (edited) fs.writeFileSync(file(), JSON.stringify({ ...read(), operator: 'later edit' }));
      await applyRemovalTransaction(planDeploymentRemoval(root, 'claude', 'sdlc-complete').writes);
      if (edited) expect(read()).toEqual({ operator: 'later edit' });
      else expect(fs.existsSync(file())).toBe(false);
    }
  });
  it('retains the creation mode on later framework deployments', async () => {
    await deploy(true);
    await deploy(true, 'marketing');
    expect(read().aiwg.mode).toBe('sdlc');
  });
});
