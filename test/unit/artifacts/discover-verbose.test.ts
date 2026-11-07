// Guard verbose request ranking against the offline package and synthetic distractors.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverCapability } from '../../../src/artifacts/query-engine-discover.js';
import { scoreEntryDetailed } from '../../../src/artifacts/query-engine-scoring.js';
import { getGraphIndexDir, type MetadataEntry } from '../../../src/artifacts/types.js';

const bugRequest = 'File a bug report issue for this problem: running `aiwg refresh` right after `aiwg use all` in a fresh project removes every managed Claude hook. Draft the full issue body here for me to review. Do not post it anywhere.';
// Verbatim p1/p2 from the 2026-11-07 harness kit; keep the test self-contained.
const uatRequests = [
  'I need a test plan for the new checkpoint command (create, list, recover). How should I go about it in this project? Give me the concrete next steps.',
  'Is there an AIWG skill that turns Jira CSV exports into flame graphs? If not, just say so.',
];
const repoRoot = path.resolve(import.meta.dirname, '../../..');
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-discover-verbose-'));
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, path.join(tmp, key));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
    'AIWG_FRAMEWORK_INDEX_CACHE', 'AIWG_FRAMEWORK_INDEX_CACHE_SOURCE']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', repoRoot);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }); });

const entry = (overrides: Partial<MetadataEntry>): MetadataEntry => ({
  path: 'skills/example/SKILL.md', type: 'skill', title: '', summary: '', tags: [],
  phase: '', created: '', updated: '', checksum: '', dependencies: [], dependents: [], ...overrides,
});

describe('verbose discovery confidence (#3952)', () => {
  it('ranks issue filing above incidental hook and verification matches from the cold packaged index', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await discoverCapability(tmp, { phrase: bugRequest, promptContext: true, limit: 3, offline: true });
    const results = JSON.parse(String(log.mock.calls.at(-1)?.[0])).results;
    expect(results[0].name).toBe('aiwg-issue');
    expect(results[0].score).toBeLessThan(1);
    const issueRank = results.findIndex((row: { name: string }) => row.name === 'aiwg-issue');
    const conformanceRank = results.findIndex((row: { name: string }) => row.name === 'conformance-verify');
    expect(conformanceRank === -1 || issueRank < conformanceRank).toBe(true);
    expect(results.filter((row: { name: string }) => row.name === 'conformance-verify')
      .every((row: { score: number }) => row.score < 0.70)).toBe(true);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('keeps short, explicit issue-filing phrases strong', () => {
    expect(scoreEntryDetailed(entry({ name: 'aiwg-issue', triggers: ['file a bug report issue'] }),
      'file a bug report issue', { relaxOverlap: true }).score).toBeGreaterThanOrEqual(1);
  });

  it.each(['title', 'capability', 'summary', 'triggers'] as const)(
    'does not turn incidental %s tokens into a perfect relaxed match', field => {
      const value = 'refresh fresh managed claude hook review body full';
      const result = scoreEntryDetailed(entry({ [field]: field === 'triggers' ? [value] : value }),
        bugRequest, { relaxOverlap: true });
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(0.70);
    });

  it('weights the leading request above trailing details and inline code', () => {
    const owner = entry({ capability: 'Compare orbital spectra', triggers: ['compare orbital spectra'] });
    const distractor = entry({ title: 'Refresh hooks', capability: 'Refresh managed hooks and review full body' });
    const request = 'Compare orbital spectra: inspect `refresh managed hooks` after the fresh run and review the full body of the output carefully.';
    const score = (item: MetadataEntry) => scoreEntryDetailed(item, request, { relaxOverlap: true }).score;
    expect(score(owner)).toBeGreaterThan(score(distractor));
    expect(score(distractor)).toBeLessThan(0.70);
    expect(score(owner)).toBeGreaterThanOrEqual(0.70);
  });

  it.each(uatRequests)('keeps weak UAT matches below the hook threshold: %s', async phrase => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await discoverCapability(tmp, { phrase, promptContext: true, limit: 3, offline: true });
    const results = JSON.parse(String(log.mock.calls.at(-1)?.[0])).results;
    expect(results).toHaveLength(3);
    for (const result of results) expect(result.score).toBeLessThan(0.70);
  });

  it('gives inline code less weight than the same trailing prose', () => {
    const noise = entry({ capability: 'Refresh managed hooks' });
    const score = (context: string) => scoreEntryDetailed(noise,
      `Compare orbital spectra: ${context} after the fresh run and inspect the full output carefully.`,
      { relaxOverlap: true }).score;
    expect(score('`refresh managed hooks`')).toBeLessThan(score('refresh managed hooks'));
  });

  it('makes the prompt hook request discovery when only weak matches exist', () => {
    vi.stubEnv('AIWG_ROOT', tmp);
    const directory = getGraphIndexDir(tmp, 'framework');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({ entries: {
      noise: entry({ name: 'noise', title: 'Refresh fresh managed Claude hooks review full body' }),
    } }));
    const moduleDir = path.join(tmp, 'dist/src/artifacts');
    fs.mkdirSync(moduleDir, { recursive: true });
    const runtime = new URL('../../../dist/src/artifacts/query-engine-discover.js', import.meta.url).href;
    fs.writeFileSync(path.join(moduleDir, 'query-engine-discover.js'),
      `export { discoverCapability } from ${JSON.stringify(runtime)};`);
    const result = spawnSync(process.execPath,
      [path.join(repoRoot, 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs')], {
        cwd: tmp, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, AIWG_PROMPT_DISCOVERY: '1' },
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: bugRequest }),
      });
    expect(result.status, result.stderr).toBe(0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain('Before any other tool call or answer, run: aiwg discover');
  });
});
