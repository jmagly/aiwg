// Offline public-response fixtures exercise refresh, cache reuse and source honesty.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSearchCachePath } from '../../../src/marketplace/cache.js';
import { formatPluginSearch } from '../../../src/marketplace/plugin-search.js';
import { marketplaceHandler } from '../../../src/cli/handlers/marketplace.js';

const fixtures = path.resolve('test/fixtures/marketplace-search/public');
let home: string;
let output: string[];
let fetchMock: ReturnType<typeof vi.fn>;
const fixture = (source: string) => JSON.parse(fs.readFileSync(path.join(fixtures, `${source}.json`), 'utf8'));
async function run(flags: string[] = [], query = 'social media') {
  output.length = 0;
  const args = ['search', query, '--plugins', '--json', ...flags];
  const status = await marketplaceHandler.execute({ args, rawArgs: ['marketplace', ...args], cwd: home, frameworkRoot: process.cwd() });
  return { status, report: output.length ? JSON.parse(output.join('\n')) : null };
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-public-search-'));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('AIWG_CACHE_DIR', path.join(home, '.aiwg/marketplace-cache'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fetchMock = vi.fn(async (url: string) => {
    const host = new URL(url).hostname;
    const source = host === 'api.github.com' ? 'github' : host === 'skills.sh' ? 'skills.sh' : 'mcp-registry';
    return new Response(JSON.stringify(fixture(source)), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
describe('public marketplace search (#4280)', () => {
  it('reports covered and skipped sources without fetching or writing by default', async () => {
    const { status, report } = await run();
    expect(status.exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
    expect(report.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'mcp-registry', status: 'skipped', reason: expect.stringContaining('--refresh') }),
      expect.objectContaining({ source: 'github', status: 'skipped' }),
      expect.objectContaining({ source: 'skills.sh', status: 'skipped' }),
      expect.objectContaining({ source: 'codex', status: 'skipped', reason: expect.stringContaining('#783') }),
      expect.objectContaining({ source: 'pulsemcp', status: 'skipped' }),
    ]));
  });
  it('refreshes three public adapters, persists dated counts and reuses caches offline', async () => {
    const { status, report } = await run(['--refresh']);
    expect(status.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const source of ['mcp-registry', 'github', 'skills.sh']) {
      expect(report.coverage).toContainEqual(expect.objectContaining({ source, status: 'searched', mode: 'refresh' }));
    }
    expect(report.results.find((r: { provider: string }) => r.provider === 'skills.sh')).toMatchObject({
      installs: { value: 1400000, asOf: '2026-11-17T12:00:00.000Z', source: expect.stringContaining('skills.sh') },
    });
    expect(report.results.find((r: { provider: string }) => r.provider === 'github')).toMatchObject({
      signals: {
        stars: { value: 42, source: expect.stringContaining('api.github.com'), asOf: '2026-11-17T12:00:00.000Z' },
        license: { value: 'MIT' }, lastPush: { value: '2026-11-16T10:00:00.000Z' },
      },
    });
    expect(report.results.find((r: { provider: string }) => r.provider === 'mcp-registry')).toMatchObject({
      signals: { version: { value: '1.2.0' }, updatedAt: { value: '2026-11-16T12:00:00.000Z' } },
    });
    expect(report.warnings.join(' ')).toMatch(/implausible.*1400000.*42/i);
    fetchMock.mockClear();
    const offline = (await run()).report;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(offline.results).toEqual(report.results);
    expect(offline.coverage).toContainEqual(expect.objectContaining({ source: 'github', mode: 'cache' }));
    vi.setSystemTime(new Date('2027-01-17T00:00:00Z'));
    const stale = (await run()).report;
    expect(stale.warnings.join(' ')).toMatch(/stale.*aiwg marketplace search.*--refresh/i);
  });
  it('updates the same query snapshot with new dated install signals', async () => {
    await run(['--refresh']);
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    const skills = fixture('skills.sh'); skills.skills[0].installs = 1500000;
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url.includes('skills.sh') ? skills : fixture(url.includes('github.com') ? 'github' : 'mcp-registry'))));
    const refreshed = (await run(['--refresh'])).report;
    expect(refreshed.results.find((r: { provider: string }) => r.provider === 'skills.sh').installs).toMatchObject({
      value: 1500000, asOf: '2026-11-18T12:00:00.000Z',
    });
    fetchMock.mockClear();
    expect((await run()).report.results).toEqual(refreshed.results);
    expect((await run([], 'unseen query')).report.results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('retains successful caches when refresh fails and distinguishes skipped uncached sources', async () => {
    await run(['--refresh']);
    const cache = getSearchCachePath('github', 'social media');
    const original = fs.readFileSync(cache, 'utf8');
    fs.rmSync(getSearchCachePath('mcp-registry', 'social media'));
    fetchMock.mockImplementation(async () => new Response('', { status: 429 }));
    const { report } = await run(['--refresh']);
    expect(report.coverage).toContainEqual(expect.objectContaining({ source: 'github', status: 'searched', mode: 'cache', reason: expect.stringContaining('HTTP 429') }));
    expect(report.coverage).toContainEqual(expect.objectContaining({ source: 'mcp-registry', status: 'skipped', reason: expect.stringContaining('HTTP 429') }));
    expect(fs.readFileSync(cache, 'utf8')).toBe(original);
    expect(report.results.some((r: { provider: string }) => r.provider === 'skills.sh')).toBe(true);
  });
  it.each(['unexpected-shape', 'bad-json', 'bad-identity', 'oversized', 'offline'])('reports %s responses without replacing healthy caches', async failure => {
    await run(['--refresh']);
    const cache = getSearchCachePath('github', 'social media');
    const original = fs.readFileSync(cache, 'utf8');
    fetchMock.mockImplementation(async () => {
      if (failure === 'offline') throw new Error('sensitive provider failure');
      const body = failure === 'bad-json' ? '{' : failure === 'oversized' ? ' '.repeat(5 * 1024 * 1024 + 1)
        : JSON.stringify(failure === 'bad-identity' ? { items: [{}] } : {});
      return new Response(body);
    });
    const { report } = await run(['--refresh']);
    expect(report.warnings.join(' ')).toMatch(/refresh failed/i);
    expect(report.warnings.join(' ')).not.toContain('sensitive provider failure');
    expect(fs.readFileSync(cache, 'utf8')).toBe(original);
  });
  it('reports corrupt query caches and refuses query/source mismatches offline', async () => {
    await run(['--refresh']);
    const github = getSearchCachePath('github', 'social media');
    fs.writeFileSync(github, '{');
    let report = (await run()).report;
    expect(report.coverage).toContainEqual(expect.objectContaining({ source: 'github', status: 'skipped' }));
    expect(report.warnings.join(' ')).toMatch(/invalid github search cache/i);
    fs.copyFileSync(getSearchCachePath('skills.sh', 'social media'), github);
    report = (await run()).report;
    expect(report.coverage).toContainEqual(expect.objectContaining({ source: 'github', status: 'skipped' }));
  });
  it.each(['claude', 'codex'])('restricts --provider %s without public requests or writes', async provider => {
    const { status, report } = await run(['--provider', provider, '--refresh']);
    expect(status.exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
    expect(report.coverage).toContainEqual(expect.objectContaining({ source: 'github', status: 'skipped', reason: `Excluded by --provider ${provider}` }));
  });
  it('preserves unknown signals, renders source coverage and discloses truncated search', async () => {
    const mcp = fixture('mcp-registry'); mcp.metadata.nextCursor = 'next-page';
    const github = fixture('github'); github.total_count = 2000;
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url.includes('github.com') ? github : url.includes('skills.sh') ? fixture('skills.sh') : mcp)));
    const { report } = await run(['--refresh']);
    const unknown = report.results.find((r: { id: string }) => r.id === 'github:example/unknown-social');
    expect(unknown.signals).toMatchObject({ stars: { value: null, asOf: null }, license: { value: null }, lastPush: { value: null } });
    expect(unknown.installs).toEqual({ value: null, asOf: null });
    const rendered = formatPluginSearch(report);
    expect(rendered).toContain('Source coverage:');
    expect(rendered).toMatch(/github: searched.*refresh/);
    expect(rendered).toContain('codex: skipped');
    expect(rendered).toContain('stars: 42 (as of 2026-11-17');
    expect(rendered).toContain('source https://api.github.com');
    expect(report.warnings.join(' ')).toMatch(/first page/i);
  });
  it('treats an empty successful snapshot as covered and warns for future cache dates', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ servers: [], metadata: {}, items: [], total_count: 0, skills: [], count: 0 })));
    const { report } = await run(['--refresh']);
    expect(report.results).toEqual([]);
    expect(report.coverage.filter((c: { mode: string }) => c.mode === 'refresh')).toHaveLength(3);
    vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
    expect((await run()).report.warnings.join(' ')).toMatch(/future/);
  });
  it('validates all arguments before authorizing network refresh', async () => {
    for (const flags of [['--provider', 'invalid'], ['--provider'], ['--max-age-days', '-1'], ['--max-age-days'], ['--unknown']]) {
      expect((await run(['--refresh', ...flags])).status.exitCode).toBe(1);
    }
    expect((await run(['--refresh'], '')).status.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('sends only public bounded JSON requests with encoded queries', async () => {
    await run(['--refresh'], 'social media & +tools');
    for (const [request, options] of fetchMock.mock.calls) {
      const url = new URL(request);
      expect(url.searchParams.get(url.hostname.includes('modelcontextprotocol') ? 'search' : 'q')).toBe('social media & +tools');
      expect(url.protocol).toBe('https:');
      expect(options).toMatchObject({ redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'aiwg-marketplace-search' } });
      expect(options.headers).not.toHaveProperty('authorization');
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it('names the refresh command in stale Claude cache warnings', async () => {
    const plugins = path.join(home, '.claude/plugins');
    fs.mkdirSync(plugins, { recursive: true });
    fs.writeFileSync(path.join(plugins, 'install-counts-cache.json'), JSON.stringify({ fetchedAt: '2026-05-08', counts: [] }));
    expect((await run()).report.warnings.join(' ')).toMatch(/stale.*aiwg marketplace search.*--refresh/i);
  });
});
