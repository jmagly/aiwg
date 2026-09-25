import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { collectPrEvidence, assessPrEvidence } from '../../../tools/security/pr-evidence-receipt.mjs';
import { createForgePrAdapter } from '../../../tools/security/pr-evidence-forge.mjs';
import { runPrEvidenceCli } from '../../../tools/security/pr-evidence-receipt-cli.mjs';

const fixture = JSON.parse(readFileSync('test/fixtures/security/pr204-style-evidence.json', 'utf8'));
const identity = { repository: fixture.repository, number: fixture.number };
const json = (value: unknown, headers = {}) => new Response(JSON.stringify(value), {
  status: 200, headers: { 'content-type': 'application/json', ...headers },
});

function githubFetch(options: { edited?: boolean; moveHead?: boolean } = {}) {
  let prReads = 0;
  const seen: string[] = [];
  const fetchImpl = async (url: string, init: any) => {
    seen.push(`${init.method} ${url}`);
    const parsed = new URL(url);
    const path = parsed.pathname;
    const page = Number(parsed.searchParams.get('page') ?? 1);
    const perPage = Number(parsed.searchParams.get('per_page') ?? 100);
    if (path === '/graphql') {
      const variables = JSON.parse(init.body).variables;
      if (variables.after) throw new Error('Unexpected GraphQL cursor');
      return json({ data: { repository: { pullRequest: {
        lastEditedAt: options.edited ? '2026-09-13T00:00:00Z' : null,
        userContentEdits: { totalCount: options.edited ? 1 : 0,
          nodes: options.edited ? [{ id: 'edit-1', editedAt: '2026-09-13T00:00:00Z', diff: '@@ changed body @@' }] : [],
          pageInfo: { hasNextPage: false, endCursor: null } },
      } } } });
    }
    if (path === '/repos/example/project/pulls/204') {
      prReads += 1;
      return json({ head: { sha: options.moveHead && prReads > 1 ? fixture.base : fixture.head,
        repo: { full_name: fixture.repository } }, base: { sha: fixture.base },
      title: fixture.title, body: fixture.body, changed_files: 3, comments: 0, commits: 1 });
    }
    if (path.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [
      { id: 7, name: 'tests', conclusion: 'success', head_sha: fixture.head },
    ] });
    if (path.endsWith('/reviews')) return json([{ id: 8, state: 'APPROVED', user: { login: 'maintainer' },
      commit_id: fixture.head, body: 'Reviewed exact head.' }]);
    if (path.endsWith('/pulls/204/comments')) return json([{ id: 9, body: 'Review the new handoff.',
      path: 'FIFA/fc-market/docs/HANDOFF.md', commit_id: fixture.head }]);
    if (path.endsWith('/commits')) return json([{ sha: fixture.head }]);
    if (path.endsWith('/files')) {
      const offset = (page - 1) * perPage;
      const files = fixture.files.slice(offset, offset + perPage)
        .map((item: any) => ({ filename: item.path, status: item.status }));
      return json(files, { link: offset + perPage < fixture.files.length
        ? `<https://api.github.com${path}?page=${page + 1}&per_page=${perPage}>; rel="next"` : '' });
    }
    if (path.endsWith('/comments')) return json([]);
    if (path.includes('/contents/')) {
      const file = decodeURIComponent(path.split('/contents/')[1]);
      expect(parsed.searchParams.get('ref')).toBe(fixture.head);
      return json({ type: 'file', encoding: 'base64', content: Buffer.from(fixture.blobs[file]).toString('base64') });
    }
    throw new Error(`Unexpected HTTP request ${url}`);
  };
  return { fetchImpl, seen };
}

describe('read-only forge PR adapters', () => {
  it('collects GitHub pages, exact-head blobs, checks, reviews and original body history', async () => {
    const http = githubFetch();
    const adapter = createForgePrAdapter({ provider: 'github', apiBaseUrl: 'https://api.github.com',
      fetchImpl: http.fetchImpl, canonicalBase: fixture.canonicalBase });
    const snapshot = await collectPrEvidence(adapter, identity, { pageSize: 2 });
    const result = assessPrEvidence(snapshot, { schemaVersion: '1', mode: 'enforce', defaultProfile: 'high-assurance' });
    expect(result.completeness.complete).toBe(true);
    expect(result.collection.files.pages).toBe(2);
    expect(result.body.history[0]).toMatchObject({ kind: 'original', text: fixture.body });
    expect(result.verified.reviews).toHaveLength(1);
    expect(result.verified.checks).toHaveLength(1);
    expect(result.assessed.some((item: any) => item.id === 'reviewComments:0')).toBe(true);
    expect(http.seen.every(line => line.startsWith('GET ') || line.startsWith('POST https://api.github.com/graphql'))).toBe(true);
  });

  it('reports missing original body after edits and invalidates a moving head', async () => {
    const http = githubFetch({ edited: true, moveHead: true });
    const adapter = createForgePrAdapter({ provider: 'github', apiBaseUrl: 'https://api.github.com',
      fetchImpl: http.fetchImpl, canonicalBase: fixture.canonicalBase });
    const snapshot = await collectPrEvidence(adapter, identity);
    expect(snapshot.omissions.map((item: any) => item.reason)).toContain('original-body-unavailable');
    expect(snapshot.omissions.map((item: any) => item.reason)).toContain('head-or-base-changed-during-collection');
    expect(assessPrEvidence(snapshot, {}).completeness.complete).toBe(false);
  });

  it('collects Gitea review/status/file endpoints and identifies unavailable history', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string, init: any) => {
      seen.push(`${init.method} ${url}`);
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path.endsWith('/pulls/204')) return json({ head: { sha: fixture.head,
        repo: { full_name: fixture.repository } }, base: { sha: fixture.base },
        title: fixture.title, body: fixture.body, changed_files: 3, commits: 1 });
      if (path.endsWith('/statuses')) return json([{ id: 5, context: 'ci', state: 'success', sha: fixture.head }],
        { 'x-total': '1', 'x-hasmore': 'false' });
      if (path.endsWith('/reviews')) return json([{ id: 6, state: 'APPROVED', user: { login: 'maintainer' },
        commit_id: fixture.head, body: 'Reviewed.' }], { 'x-total': '1', 'x-hasmore': 'false' });
      if (path.endsWith('/reviews/6/comments')) return json([{ id: 10, body: 'Check this line.',
        commit_id: fixture.head }], { 'x-total': '1', 'x-hasmore': 'false' });
      if (path.endsWith('/commits')) return json([{ sha: fixture.head }], { 'x-total': '1', 'x-hasmore': 'false' });
      if (path.endsWith('/files')) return json(fixture.files.map((item: any) => ({ filename: item.path,
        status: item.status })), { 'x-total': '3', 'x-hasmore': 'false' });
      if (path.endsWith('/comments')) return json([], { 'x-total': '0', 'x-hasmore': 'false' });
      if (path.includes('/raw/')) {
        const file = decodeURIComponent(path.split('/raw/')[1]);
        expect(parsed.searchParams.get('ref')).toBe(fixture.head);
        return new Response(fixture.blobs[file], { status: 200 });
      }
      throw new Error(`Unexpected HTTP request ${url}`);
    };
    const adapter = createForgePrAdapter({ provider: 'gitea', apiBaseUrl: 'https://gitea.example/api/v1',
      fetchImpl, canonicalBase: fixture.canonicalBase });
    const snapshot = await collectPrEvidence(adapter, identity);
    const result = assessPrEvidence(snapshot, {});
    expect(result.completeness.complete).toBe(false);
    expect(result.completeness.omissions.some((item: any) => item.surface === 'bodyHistory')).toBe(true);
    expect(result.verified.reviews).toHaveLength(1);
    expect(result.verified.checks).toHaveLength(1);
    expect(result.assessed.some((item: any) => item.id === 'reviewComments:0')).toBe(true);
    expect(seen.every(line => line.startsWith('GET '))).toBe(true);
  });

  it('runs the CLI entry point against a read-only fixture HTTP transport', async () => {
    const http = githubFetch();
    let output = '';
    await runPrEvidenceCli([
      '--provider', 'github', '--api-url', 'https://api.github.com', '--repo', fixture.repository,
      '--number', String(fixture.number), '--base-context',
      'test/fixtures/security/pr204-style-canonical-base.json', '--proposed-action', 'merge',
    ], { fetchImpl: http.fetchImpl, stdout: { write: (value: string) => { output += value; } } });
    const result = JSON.parse(output);
    expect(result.head).toBe(fixture.head);
    expect(result.completeness.complete).toBe(true);
    expect(result.nextAction.gate).toBe('manual-review-required');
    expect(http.seen.some(line => line.includes('/contents/FIFA/fc-market/docs/HANDOFF.md'))).toBe(true);
  });

  it('reports PR merge state and ignores a GitHub test-merge SHA before merge (#2719)', async () => {
    const mergeSha = 'e'.repeat(40);
    for (const [provider, merged] of [['github', false], ['github', true], ['gitea', true], ['gitea', false]] as const) {
      const fetchImpl = async () => json({ state: merged ? 'closed' : 'open', merged, merged_at: merged ? '2026-09-24T00:00:00Z' : null,
        merge_commit_sha: merged || provider === 'github' ? mergeSha : null, base: { ref: 'main', sha: fixture.base } });
      const adapter = createForgePrAdapter({ provider, apiBaseUrl: 'https://forge.example.test/api/v1', token: 'x',
        fetchImpl, canonicalBase: { source: 'trusted-base' } });
      expect(await adapter.getPullState(identity)).toEqual({ state: merged ? 'closed' : 'open', merged,
        mergedAt: merged ? '2026-09-24T00:00:00Z' : null, mergeCommitSha: merged ? mergeSha : null, base: { ref: 'main', sha: fixture.base } });
    }
  });
});
