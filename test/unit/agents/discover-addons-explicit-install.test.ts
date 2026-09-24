import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverAddons, getAddonSkillDirs } from '../../../tools/agents/providers/base.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

// Framework-mode deploys (`aiwg use sdlc`, `aiwg use all --copy-all`) collect
// addon content through discoverAddons(); explicitInstall addons deploy only
// when named (#2641).
describe('discoverAddons explicitInstall', () => {
  it('skips explicitInstall and devOnly addons but keeps autoInstall:false ones', async () => {
    const srcRoot = await mkdtemp(path.join(os.tmpdir(), 'aiwg-discover-addons-'));
    temps.push(srcRoot);
    const manifests: Record<string, object> = {
      'opt-in': { explicitInstall: true, autoInstall: false },
      contributor: { devOnly: true },
      plain: { autoInstall: false },
    };
    for (const [name, manifest] of Object.entries(manifests)) {
      const skill = path.join(srcRoot, 'agentic/code/addons', name, 'skills', `${name}-skill`);
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, 'SKILL.md'), `---\nname: ${name}-skill\n---\n`);
      await writeFile(path.join(srcRoot, 'agentic/code/addons', name, 'manifest.json'), JSON.stringify(manifest));
    }
    expect(discoverAddons(srcRoot).map((addon: { name: string }) => addon.name)).toEqual(['plain']);
    expect(getAddonSkillDirs(srcRoot).map((dir: string) => path.basename(dir))).toEqual(['plain-skill']);
  });

  it('keeps decision-engine out of bulk deploys from the real tree', () => {
    const names = discoverAddons(root).map((addon: { name: string }) => addon.name);
    expect(names).not.toContain('decision-engine');
    expect(names).toEqual(expect.arrayContaining(['composition-engine', 'testing-quality', 'aiwg-utils']));
    expect(getAddonSkillDirs(root).some((dir: string) => path.basename(dir) === 'decision-evaluate')).toBe(false);
  });
});
