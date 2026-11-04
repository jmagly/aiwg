// Discovery regression checks use synthetic corpora, provider files and isolated caches.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnoseFacetActivations } from '../../../src/artifacts/discover-facets.js';
import { projectCapabilityFallback } from '../../../src/artifacts/query-engine-entries.js';
import { scoreEntryDetailed } from '../../../src/artifacts/query-engine-scoring.js';
import { isArtifactInstalled } from '../../../src/artifacts/query-engine-installation.js';
import { emitShowCard } from '../../../src/artifacts/query-engine-show-card.js';
import { discoverCapability } from '../../../src/artifacts/query-engine-discover.js';
import { refreshFrameworkCapabilities } from '../../../src/artifacts/framework-capabilities.js';
import * as builder from '../../../src/artifacts/index-builder.js';
import * as digests from '../../../src/artifacts/framework-source-digest.js';
import { getGraphIndexDir, type MetadataEntry } from '../../../src/artifacts/types.js';

let tmp: string;
function put(relative: string, text: string): void {
  const target = path.join(tmp, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
const entry = (overrides: Partial<MetadataEntry> = {}): MetadataEntry => ({
  path: 'agentic/code/addons/example/skills/work/SKILL.md', type: 'skill', title: 'Work', name: 'work',
  summary: '', tags: [], phase: '', created: '', updated: '', checksum: '', dependencies: [], dependents: [], ...overrides,
});
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-discovery-runtime-'));
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, path.join(tmp, key));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', tmp);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('quiet project fallback', () => {
  it('ignores a registry and empty bundle directories because no capabilities are lost', () => {
    put('.aiwg/frameworks/registry.json', '{}');
    fs.mkdirSync(path.join(tmp, '.aiwg/extensions/empty/skills'), { recursive: true });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(projectCapabilityFallback(tmp)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
  it('warns once across calls per degraded source state, then warns again for changed sources', () => {
    put('.aiwg/skills/custom/SKILL.md', '# Custom');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    projectCapabilityFallback(tmp);
    projectCapabilityFallback(tmp);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('aiwg index build --graph project'));
    put('.aiwg/skills/custom/SKILL.md', '# Changed custom skill');
    projectCapabilityFallback(tmp);
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it('serves complete source metadata quietly when only the derived cache is missing', () => {
    put('.aiwg/.index/project/metadata.json', JSON.stringify({ entries: { work: entry() } }));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(projectCapabilityFallback(tmp)?.map(item => item.name)).toEqual(['work']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('lexical confidence', () => {
  it('does not route generic authoring or test descriptions through session continuity', () => {
    for (const phrase of ['write a code generator', 'create a software architecture', 'fix a deployment']) {
      expect(diagnoseFacetActivations(phrase).filter(item =>
        ['Session checkpoint and handoff', 'Repair failing tests'].includes(item.label))).toEqual([]);
    }
  });
  it('credits coherent triggers and upgrades incidental hits from stronger fields', () => {
    const coherent = scoreEntryDetailed(entry({ triggers: ['memory location', 'memory ingest'] }),
      'knowledge ingest memory', { relaxOverlap: true });
    expect(coherent.score).toBeCloseTo(0.8);
    const upgraded = scoreEntryDetailed(entry({ title: 'Media collection', triggers: ['media type'] }),
      'media collection metadata', { relaxOverlap: true });
    expect(upgraded.score).toBeCloseTo(0.48);
  });
  it('does not saturate from disconnected trigger tokens or one generic trigger', () => {
    const query = 'resume a conductor handoff and continue the November plan';
    const weak = scoreEntryDetailed(entry({ triggers: ['continue ingestion', 'resume dataset sync', 'run dataset plan'] }), query, { relaxOverlap: true });
    expect(weak.score).toBeLessThan(0.5);
    const generic = scoreEntryDetailed(entry({ triggers: ['write'] }), 'write a session handoff', { relaxOverlap: true });
    expect(generic.score).toBeLessThan(0.5);
    expect(scoreEntryDetailed(entry(), 'work').score).toBeGreaterThan(1);
  });
});

describe('actual provider deployment availability', () => {
  it.each(['.agents/skills', '.claude/skills', '.codex/.aiwg/skills'])(
    'finds a deployed skill under %s without a bundle installation record', async directory => {
      put(`${directory}/work/SKILL.md`, '# Work');
      expect(await isArtifactInstalled(tmp, tmp, entry(), 'addon', 'example')).toBe(true);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await emitShowCard(tmp, tmp, entry(), path.join(tmp, entry().path), '# Work', { name: 'work', json: true },
        { fields: {}, text: '' }, {}, true);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).installed).toBe(true);
    });
  it('reports an absent skill with a concrete load command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await emitShowCard(tmp, tmp, entry(), path.join(tmp, entry().path), '# Work', { name: 'work', json: true },
      { fields: {}, text: '' }, {}, true);
    const card = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(card.installed).toBe(false);
    expect(card.load_hint).toContain('--body');
    expect(card.load_hint).toContain('aiwg use example');
  });
  it('recognizes implicit utils installation for standard skills without copies', async () => {
    put('.aiwg/aiwg.config', JSON.stringify({ installed: { all: { deployedTo: { codex: { skills: 26 } } } } }));
    expect(await isArtifactInstalled(tmp, tmp, entry(), 'addon', 'aiwg-utils')).toBe(true);
    put('.aiwg/aiwg.config', JSON.stringify({ installed: { all: { deployedTo: { codex: { skipUtils: true } } } } }));
    expect(await isArtifactInstalled(tmp, tmp, entry(), 'addon', 'aiwg-utils')).toBe(false);
  });
});

it('uses reconciled metadata on a warm framework query without loading or building fulltext', async () => {
  put('package.json', '{"name":"aiwg","version":"1.0.0"}');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    fs.mkdirSync(path.join(tmp, 'agentic/code', kind), { recursive: true });
  }
  put(entry().path, '---\nname: work\ndescription: Perform synthetic work\n---\n# Work\n');
  await refreshFrameworkCapabilities(tmp, false);
  const build = vi.spyOn(builder, 'buildIndex');
  const digest = vi.spyOn(digests, 'frameworkSourceDigest');
  const read = vi.spyOn(fs, 'readFileSync');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  await discoverCapability(tmp, { phrase: 'work', json: true });
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).results[0].name).toBe('work');
  expect(build).not.toHaveBeenCalled();
  expect(digest).toHaveBeenCalledTimes(1);
  expect(read.mock.calls.some(([file]) => String(file).includes('aiwg-fortemi-index'))).toBe(false);
  expect(fs.existsSync(path.join(path.dirname(getGraphIndexDir(tmp, 'framework')), 'fortemi-core'))).toBe(false);
  expect(warn).not.toHaveBeenCalled();
});
