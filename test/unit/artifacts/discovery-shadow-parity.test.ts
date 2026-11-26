// Exercise real discovery output with the optional shadow observer enabled.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { discoverCapability } from '../../../src/artifacts/query-engine.js';
import { DiscoveryShadowRoute, type DiscoveryShadowReceipt } from '../../../src/artifacts/discovery-shadow.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.each(['intake-first', 'onboarding forms'])('real discovery returns byte-equivalent results and zero model calls for %s', async phrase => {
  const cwd = await mkdtemp(join(tmpdir(), 'aiwg-shadow-parity-')); roots.push(cwd);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'aiwg' }));
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    await mkdir(join(cwd, 'agentic/code', kind), { recursive: true });
  }
  for (const [name, description] of [['intake-first', 'onboarding forms'], ['recovery-second', 'disaster recovery']]) {
    const dir = join(cwd, 'agentic/code/frameworks/fixture/skills', name!); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
  }
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await buildIndex(cwd, { graph: 'framework', force: true, explicit: true }); output.length = 0;
  const options = { phrase, graph: 'framework' as const, json: true, backend: 'local' as const, limit: 3, noBuild: true };
  await discoverCapability(cwd, options);
  const baseline = JSON.stringify(JSON.parse(output.join('\n')).results); output.length = 0;
  const evaluate = vi.fn(async () => { throw new Error('unexpected model call'); }), authorize = vi.fn(() => true);
  const records: DiscoveryShadowReceipt[] = [];
  const pin = { id: 'synthetic', version: '1', digest: `sha256:${'a'.repeat(64)}` as const };
  const route = new DiscoveryShadowRoute({ mode: 'shadow', ambiguity: { version: 'discovery-ambiguity/v1',
    minimumScore: 0, minimumMargin: .01, maximumCandidates: 3, maximumTextBytes: 4096 },
    definition: pin, binding: pin, allowedModels: ['synthetic'], uncertaintyProfile: 'fixture', calibrationDigest: pin.digest,
    minimumProbability: .75, minimumMargin: .25, maximumLatencyMs: 100, maximumTokens: 100, maximumCostUsd: 1,
  }, { authorize, evaluate, record: record => records.push(record) });
  await discoverCapability(cwd, { ...options, shadowRoute: route });
  expect(JSON.parse(baseline).length).toBeGreaterThan(0);
  expect(JSON.stringify(JSON.parse(output.join('\n')).results)).toBe(baseline);
  expect(records[0]!.reason).toBe(phrase === 'intake-first' ? 'exact-name' : 'high-margin');
  expect(evaluate).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
});
