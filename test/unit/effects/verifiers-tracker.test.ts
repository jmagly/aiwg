/**
 * Tracker verifiers (#2719): tracker.comment, tracker.issue.closed and
 * tracker.pr.merged over Gitea and GitHub response shapes, tracker authority
 * and access order, pagination, access-gap mapping and redaction. Offline:
 * every forge is a mocked `fetch` or a fake CLI runner.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiwgConfig } from '../../../src/config/aiwg-config.js';
import {
  createBuiltinVerifierRegistry,
  createTrackerVerifiers,
  parseEffectIdTrailers,
  parseEffectMarkers,
  payloadDigest,
  reconcileEffect,
  recordIntent,
  renderEffectMarker,
  runVerifier,
  trackerCommentVerifier,
  trackerIssueClosedVerifier,
  trackerPrMergedVerifier,
  type EffectVerifierExpectation,
  type EffectVerifierRequest,
  type TrackerVerifierOptions,
} from '../../../src/effects/index.js';
import { forgeEndpointFromRemote, forgePagination, parseIncludedResponse } from '../../../src/tracker/forge-http.js';
import { comment as commentIntent, harness, scope, type Harness } from './helpers.js';

const CANARY = 'canary-7d1f0c9e4b2a-forge-access';
const EFFECT = `eff1_${'b'.repeat(51)}q`;
const OTHER_EFFECT = `eff1_${'c'.repeat(51)}a`;
const RECORDED = '2026-09-24T10:00:00.000Z';
const LATER = Date.parse('2026-09-24T11:00:00.000Z');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const config: AiwgConfig = {
  remotes: {
    primary: 'origin', issue_tracker: 'origin', issue_provider: 'gitea',
    tracker_actor: { login: 'delivery-bot', via: 'api', forbid_actors: ['legacy-bot'] },
    customer_issue_tracker: 'github', customer_issue_provider: 'github',
    customer_tracker_actor: { login: 'delivery-bot', via: 'api' },
    secondary: [{ name: 'mirror', purpose: 'mirror' }],
  },
} as AiwgConfig;
const remoteUrls = {
  origin: 'git@forge.example.test:example/repo.git',
  github: 'https://github.com/example/repo.git',
  mirror: 'https://mirror.example.test/example/repo.git',
};
const env = { AIWG_GITEA_TOKEN: CANARY, AIWG_GITHUB_TOKEN: CANARY };
const BASES = { gitea: 'https://forge.example.test/api/v1', github: 'https://api.github.com' } as const;
type Provider = keyof typeof BASES;

interface Comment { id: number; author: string; body: string; created_at?: string }
interface ForgeState {
  comments?: Comment[];
  pageSize?: number;
  issueState?: 'open' | 'closed';
  pr?: { state: 'open' | 'closed'; merged: boolean; merge_commit_sha?: string | null; merged_at?: string | null };
  commitMessage?: string;
  /** Return this status (and headers) for every request. */
  fail?: { status: number; headers?: Record<string, string> };
  /** Drop pagination headers on full pages (Gitea without x-total-count). */
  noPaginationHeaders?: boolean;
  /** Claim more comments than exist, truncating the chain. */
  totalOverride?: number;
  hang?: boolean;
  networkError?: boolean;
  oversized?: boolean;
}

interface Traffic { urls: string[]; authorizations: string[] }

/** A read-only fake forge in the Gitea or GitHub response shape. */
function fakeForge(provider: Provider, state: ForgeState, traffic: Traffic): typeof fetch {
  const pageSize = state.pageSize ?? 2;
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    traffic.urls.push(url.toString());
    const headers = new Headers(init?.headers);
    traffic.authorizations.push(headers.get('authorization') ?? '');
    if (state.networkError) throw new TypeError(`connect ECONNREFUSED with ${CANARY}`);
    if (state.hang) {
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    const reply = (status: number, value: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(value), {
      status, headers: { 'content-type': 'application/json', 'x-request-echo': CANARY, ...extra },
    });
    if (state.fail) return reply(state.fail.status, { message: `denied for ${CANARY}` }, state.fail.headers);
    if (state.oversized) return new Response('x'.repeat(4096), { status: 200, headers: { 'content-length': '4096' } });
    const prefix = `${new URL(BASES[provider]).pathname.replace(/\/$/, '')}/repos/example/repo`;
    const path = url.pathname;
    if (path === `${prefix}/issues/12`) {
      return reply(200, { number: 12, state: state.issueState ?? 'open', closed_at: state.issueState === 'closed' ? RECORDED : null, body: CANARY });
    }
    if (path === `${prefix}/issues/12/comments`) {
      const page = Number(url.searchParams.get('page') ?? 1);
      const size = Number(url.searchParams.get(provider === 'github' ? 'per_page' : 'limit'));
      expect(size).toBe(pageSize);
      const all = state.comments ?? [];
      const items = all.slice((page - 1) * pageSize, page * pageSize).map(item => ({
        id: item.id, body: item.body, created_at: item.created_at ?? RECORDED,
        user: provider === 'github' ? { login: item.author } : { login: item.author, username: item.author },
      }));
      const total = state.totalOverride ?? all.length;
      const extra: Record<string, string> = {};
      if (!state.noPaginationHeaders) {
        if (provider === 'gitea') extra['x-total-count'] = String(total);
        else if (page * pageSize < total) extra.link = `<${BASES.github}/repos/example/repo/issues/12/comments?page=${page + 1}&per_page=${pageSize}>; rel="next"`;
      }
      return reply(200, items, extra);
    }
    if (path === `${prefix}/pulls/12`) {
      const pr = state.pr ?? { state: 'open', merged: false };
      // GitHub reports a test-merge SHA for an unmerged PR; the verifier must ignore it.
      const mergeSha = pr.merge_commit_sha !== undefined ? pr.merge_commit_sha : provider === 'github' ? OTHER_SHA : null;
      return reply(200, {
        number: 12, state: pr.state, merged: pr.merged, merged_at: pr.merged_at ?? (pr.merged ? RECORDED : null),
        merge_commit_sha: mergeSha, base: { ref: 'main', sha: 'c'.repeat(40) }, head: { sha: 'd'.repeat(40) }, body: CANARY,
      });
    }
    const commitPath = provider === 'github' ? `${prefix}/commits/${SHA}` : `${prefix}/git/commits/${SHA}`;
    if (path === commitPath) return reply(200, { sha: SHA, commit: { message: state.commitMessage ?? 'Merge pull request' } });
    return reply(404, { message: 'not found' });
  }) as typeof fetch;
}

function setup(provider: Provider, state: ForgeState, overrides: Partial<TrackerVerifierOptions> = {}) {
  const traffic: Traffic = { urls: [], authorizations: [] };
  const options: TrackerVerifierOptions = {
    config, remoteUrls, env, cli: false, now: () => LATER,
    fetchImpl: fakeForge(provider, state, traffic), pageSize: state.pageSize ?? 2, ...overrides,
  };
  return { traffic, options };
}

const request = (kind: string, provider: Provider, expected: EffectVerifierExpectation = {}, extra: Partial<EffectVerifierRequest> = {}): Omit<EffectVerifierRequest, 'signal'> => ({
  effectId: EFFECT, scope, kind, target: `${provider}:example/repo#12`, context: { issue: 12 },
  payloadDigest: payloadDigest('payload that differs from every fixture body'), intentRecordedAt: RECORDED, expected, ...extra,
});

const marker = (id = EFFECT) => `Cycle update\n\n${renderEffectMarker(id)}\n`;
const PROVIDERS: Provider[] = ['gitea', 'github'];

describe('marker helpers', () => {
  it('EFF-TRK-01 renders and parses the effect marker and Effect-Id trailers exactly', () => {
    expect(renderEffectMarker(EFFECT)).toBe(`<!-- aiwg-effect: ${EFFECT} -->`);
    expect(parseEffectMarkers(`a ${renderEffectMarker(EFFECT)} b <!--aiwg-effect:${OTHER_EFFECT}-->`)).toEqual([EFFECT, OTHER_EFFECT]);
    expect(parseEffectMarkers(`<!-- aiwg-effect: ${EFFECT}x -->`)).not.toContain(EFFECT);
    expect(parseEffectIdTrailers(`Subject\n\nBody\n\nEffect-Id: ${EFFECT}\nSigned-off-by: x`)).toEqual([EFFECT]);
    expect(() => renderEffectMarker('bad id -->')).toThrow();
  });

  it('EFF-TRK-02 derives the API base from the tracker remote, never from a default host', () => {
    expect(forgeEndpointFromRemote('gitea', 'git@forge.example.test:example/repo.git')).toEqual({ host: 'forge.example.test', repository: 'example/repo', apiBaseUrl: 'https://forge.example.test/api/v1' });
    expect(forgeEndpointFromRemote('gitea', 'ssh://git@forge.example.test:2222/example/repo.git')?.apiBaseUrl).toBe('https://forge.example.test/api/v1');
    expect(forgeEndpointFromRemote('gitea', 'https://forge.example.test/git/example/repo')?.apiBaseUrl).toBe('https://forge.example.test/git/api/v1');
    expect(forgeEndpointFromRemote('github', 'git@github.com:example/repo.git')?.apiBaseUrl).toBe('https://api.github.com');
    expect(forgeEndpointFromRemote('github', 'https://ghe.example.test/example/repo.git')?.apiBaseUrl).toBe('https://ghe.example.test/api/v3');
    expect(forgeEndpointFromRemote('gitea', undefined)).toBeNull();
    expect(forgeEndpointFromRemote('gitea', 'not a url')).toBeNull();
  });

  it('EFF-TRK-03 pagination is complete only when the headers prove the last page', () => {
    expect(forgePagination({ 'x-total-count': '3' }, [1], 2, 2)).toMatchObject({ nextPage: null, complete: true });
    expect(forgePagination({ 'x-total-count': '5' }, [1, 2], 2, 2)).toMatchObject({ nextPage: 3, complete: false });
    expect(forgePagination({}, [1, 2], 1, 2)).toMatchObject({ nextPage: null, complete: false });
    expect(forgePagination({}, [1], 1, 2)).toMatchObject({ nextPage: null, complete: true });
    expect(forgePagination({ 'x-total-count': '9' }, [1], 3, 2)).toMatchObject({ nextPage: null, complete: false });
    expect(forgePagination({ link: '<https://h/x?page=4>; rel="next"' }, [1, 2], 3, 2)).toMatchObject({ nextPage: 4 });
    expect(forgePagination({ 'x-total-count': '3' }, [1, 2, 3], 1, 2)).toMatchObject({ nextPage: null, complete: true });
  });
});

describe.each(PROVIDERS)('%s tri-state', (provider) => {
  it('EFF-TRK-10 tracker.pr.merged: merged with matching SHA is present with SHA and PR evidence', async () => {
    const { options } = setup(provider, { pr: { state: 'closed', merged: true, merge_commit_sha: SHA }, commitMessage: `Merge\n\nEffect-Id: ${EFFECT}\n` });
    const run = await runVerifier(trackerPrMergedVerifier(options), request('tracker.pr.merged', provider, { object: SHA }));
    expect(run.observation).toMatchObject({ result: 'present', reason: 'marker-match', complete: true });
    expect(run.evidence).toMatchObject({ tracker: provider, repository: 'example/repo', number: 12, mergeCommit: SHA, expectedMergeCommit: SHA, mergeCommitMatch: true, marker: true });
  });

  it('EFF-TRK-11 tracker.pr.merged: merged without a trailer is state-match', async () => {
    const { options } = setup(provider, { pr: { state: 'closed', merged: true, merge_commit_sha: SHA } });
    const run = await runVerifier(trackerPrMergedVerifier(options), request('tracker.pr.merged', provider));
    expect(run.observation).toMatchObject({ result: 'present', reason: 'state-match' });
    expect(run.evidence).toMatchObject({ marker: false, mergeCommit: SHA });
  });

  it.each([
    { name: 'open', pr: { state: 'open' as const, merged: false } },
    { name: 'closed unmerged', pr: { state: 'closed' as const, merged: false } },
  ])('EFF-TRK-12 tracker.pr.merged: $name PR is absent and ignores any test-merge SHA', async ({ pr }) => {
    const { options } = setup(provider, { pr });
    const run = await runVerifier(trackerPrMergedVerifier(options), request('tracker.pr.merged', provider, { object: SHA }));
    expect(run.observation).toMatchObject({ result: 'absent', reason: 'complete-query-no-match', complete: true });
    expect(run.evidence).toMatchObject({ merged: false, mergeCommit: null });
  });

  it('EFF-TRK-13 tracker.pr.merged: a merge-SHA mismatch is absent with mergeCommitMatch false', async () => {
    const { options } = setup(provider, { pr: { state: 'closed', merged: true, merge_commit_sha: SHA } });
    const run = await runVerifier(trackerPrMergedVerifier(options), request('tracker.pr.merged', provider, { object: OTHER_SHA }));
    expect(run.observation).toMatchObject({ result: 'absent', reason: 'complete-query-no-match' });
    expect(run.evidence).toMatchObject({ mergeCommitMatch: false, mergeCommit: SHA, expectedMergeCommit: OTHER_SHA });
  });

  it.each([
    { issueState: 'closed' as const, result: 'present', reason: 'state-match' },
    { issueState: 'open' as const, result: 'absent', reason: 'complete-query-no-match' },
  ])('EFF-TRK-14 tracker.issue.closed: $issueState issue is $result', async ({ issueState, result, reason }) => {
    const { options } = setup(provider, { issueState });
    const run = await runVerifier(trackerIssueClosedVerifier(options), request('tracker.issue.closed', provider));
    expect(run.observation).toMatchObject({ result, reason, complete: true });
    expect(run.evidence).toMatchObject({ state: issueState });
  });

  it('EFF-TRK-15 tracker.comment: the marker on the last of several pages is present', async () => {
    const comments = [
      { id: 1, author: 'delivery-bot', body: 'first' }, { id: 2, author: 'someone', body: 'second' },
      { id: 3, author: 'delivery-bot', body: marker(OTHER_EFFECT) }, { id: 4, author: 'someone', body: 'fourth' },
      { id: 5, author: 'Delivery-Bot', body: marker() },
    ];
    const { options, traffic } = setup(provider, { comments });
    const run = await runVerifier(trackerCommentVerifier(options), request('tracker.comment', provider));
    expect(run.observation).toMatchObject({ result: 'present', reason: 'marker-match', complete: true });
    expect(run.evidence).toMatchObject({ commentId: 5, pages: 3, scanned: 5, confidence: 'exact', bodyDigest: payloadDigest(marker()) });
    expect(traffic.urls.filter(url => url.includes('/comments')).length).toBe(3);
  });

  it('EFF-TRK-16 tracker.comment: a body matching the payload digest is digest-match; a pinned digest mismatch conflicts', async () => {
    const body = marker();
    const { options } = setup(provider, { comments: [{ id: 9, author: 'delivery-bot', body }] });
    const exact = await runVerifier(trackerCommentVerifier(options), request('tracker.comment', provider, {}, { payloadDigest: payloadDigest(body) }));
    expect(exact.observation).toMatchObject({ result: 'present', reason: 'digest-match' });
    const conflict = await runVerifier(trackerCommentVerifier(options), request('tracker.comment', provider, { digest: payloadDigest('other') }));
    expect(conflict.observation).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
  });

  it('EFF-TRK-17 tracker.comment: no marker after every page is absent', async () => {
    const comments = [1, 2, 3, 4, 5].map(id => ({ id, author: 'delivery-bot', body: marker(OTHER_EFFECT) }));
    const { options } = setup(provider, { comments });
    const run = await runVerifier(trackerCommentVerifier(options), request('tracker.comment', provider));
    expect(run.observation).toMatchObject({ result: 'absent', reason: 'complete-query-no-match', complete: true });
    expect(run.evidence).toMatchObject({ pages: 3, scanned: 5, found: false });
  });

  it.each(['someone', 'legacy-bot'])('EFF-TRK-18 tracker.comment: a marker written by %s is never present', async (author) => {
    const { options } = setup(provider, { comments: [{ id: 1, author, body: marker() }] });
    const run = await runVerifier(trackerCommentVerifier(options), request('tracker.comment', provider));
    expect(run.observation).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
    expect(run.evidence).toMatchObject({ foreignMarker: true });
  });

  it('EFF-TRK-19 tracker.comment: without a pinned actor a marker is never present', async () => {
    const unpinned = { remotes: { ...config.remotes, tracker_actor: undefined, customer_tracker_actor: undefined } } as AiwgConfig;
    const { options } = setup(provider, { comments: [{ id: 1, author: 'delivery-bot', body: marker() }] }, { config: unpinned });
    const run = await runVerifier(trackerCommentVerifier(options), request('tracker.comment', provider));
    expect(run.observation.result).toBe('unknown');
  });

  it('EFF-TRK-20 tracker.comment: an author and time-window match is heuristic present, never absent', async () => {
    const comments = [{ id: 7, author: 'delivery-bot', body: 'Cycle update without marker', created_at: '2026-09-24T10:00:20.000Z' }];
    const { options } = setup(provider, { comments }, { heuristicWindowMs: 120_000 });
    const run = await runVerifier(trackerCommentVerifier(options), request('tracker.comment', provider));
    expect(run.observation).toMatchObject({ result: 'present', reason: 'heuristic-match', complete: false });
    expect(run.evidence).toMatchObject({ commentId: 7, confidence: 'heuristic' });
    // Outside the window, or with the heuristic off, the same scan is absent, not heuristic.
    const off = setup(provider, { comments });
    expect((await runVerifier(trackerCommentVerifier(off.options), request('tracker.comment', provider))).observation.result).toBe('absent');
  });

  it('EFF-TRK-21 absent needs a minimum intent age; a young intent is consistency-lag', async () => {
    const young = { now: () => Date.parse(RECORDED) + 5_000 };
    const cases = [
      { verifier: trackerCommentVerifier(setup(provider, { comments: [] }, young).options), kind: 'tracker.comment' },
      { verifier: trackerIssueClosedVerifier(setup(provider, { issueState: 'open' }, young).options), kind: 'tracker.issue.closed' },
      { verifier: trackerPrMergedVerifier(setup(provider, { pr: { state: 'open', merged: false } }, young).options), kind: 'tracker.pr.merged' },
    ];
    for (const { verifier, kind } of cases) {
      expect((await runVerifier(verifier, request(kind, provider))).observation).toMatchObject({ result: 'unknown', reason: 'consistency-lag', complete: false });
    }
  });
});

describe('access gaps map to unknown', () => {
  const cases: Array<{ name: string; provider: Provider; state: ForgeState; overrides?: Partial<TrackerVerifierOptions>; reason: string; timeoutMs?: number }> = [
    { name: '401', provider: 'gitea', state: { fail: { status: 401 } }, reason: 'auth-denied' },
    { name: '403', provider: 'gitea', state: { fail: { status: 403 } }, reason: 'auth-denied' },
    { name: 'GitHub 403 with exhausted quota', provider: 'github', state: { fail: { status: 403, headers: { 'x-ratelimit-remaining': '0' } } }, reason: 'rate-limited' },
    { name: '404 on the repository', provider: 'gitea', state: { fail: { status: 404 } }, reason: 'container-unreadable' },
    { name: '429', provider: 'github', state: { fail: { status: 429, headers: { 'retry-after': '30' } } }, reason: 'rate-limited' },
    { name: '500', provider: 'gitea', state: { fail: { status: 500 } }, reason: 'server-error' },
    { name: 'network error', provider: 'gitea', state: { networkError: true }, reason: 'network-error' },
    { name: 'timeout', provider: 'gitea', state: { hang: true }, reason: 'timeout', timeoutMs: 30 },
    { name: 'truncated page chain', provider: 'gitea', state: { comments: [{ id: 1, author: 'x', body: 'a' }, { id: 2, author: 'x', body: 'b' }, { id: 3, author: 'x', body: 'c' }], totalOverride: 9 }, reason: 'paging-incomplete' },
    { name: 'full page with no pagination headers', provider: 'gitea', state: { comments: [{ id: 1, author: 'x', body: 'a' }, { id: 2, author: 'x', body: 'b' }], noPaginationHeaders: true }, reason: 'paging-incomplete' },
    { name: 'page bound exceeded', provider: 'github', state: { comments: [1, 2, 3, 4, 5].map(id => ({ id, author: 'x', body: 'a' })) }, overrides: { maxPages: 2 }, reason: 'paging-incomplete' },
    { name: 'oversized body', provider: 'gitea', state: { oversized: true }, overrides: { maxResponseBytes: 1024 }, reason: 'malformed-response' },
    { name: 'blocker: no credentials and no CLI', provider: 'gitea', state: {}, overrides: { env: {} }, reason: 'tracker-blocked' },
    { name: 'blocker: GitHub CLI unauthenticated', provider: 'github', state: {}, overrides: { env: {}, cli: { available: true, authenticated: false } }, reason: 'tracker-blocked' },
  ];

  it.each(cases)('EFF-TRK-30 $name gives unknown/$reason for every tracker kind', async ({ provider, state, overrides, reason, timeoutMs }) => {
    const { options, traffic } = setup(provider, state, overrides);
    const kinds = reason === 'paging-incomplete' ? ['tracker.comment'] : ['tracker.comment', 'tracker.issue.closed', 'tracker.pr.merged'];
    for (const verifier of createTrackerVerifiers(options).filter(item => kinds.includes(item.kind))) {
      const run = await runVerifier(verifier, request(verifier.kind, provider), timeoutMs ? { timeoutMs } : {});
      expect(run.observation, verifier.kind).toMatchObject({ result: 'unknown', reason, complete: false });
      expect(JSON.stringify(run)).not.toContain(CANARY);
    }
    if (reason === 'tracker-blocked') expect(traffic.urls).toEqual([]);
  });
});

describe('tracker authority', () => {
  it('EFF-TRK-40 contacts only the remote resolveTrackerAuthority selects, never the mirror', async () => {
    for (const provider of PROVIDERS) {
      const { options, traffic } = setup(provider, { comments: [{ id: 1, author: 'delivery-bot', body: marker() }], issueState: 'closed', pr: { state: 'closed', merged: true, merge_commit_sha: SHA } });
      for (const verifier of createTrackerVerifiers(options)) await runVerifier(verifier, request(verifier.kind, provider));
      expect(traffic.urls.length).toBeGreaterThan(0);
      for (const url of traffic.urls) expect(url.startsWith(`${BASES[provider]}/repos/example/repo/`)).toBe(true);
      expect(traffic.urls.some(url => url.includes('mirror.example.test'))).toBe(false);
      expect(new Set(traffic.authorizations)).toEqual(new Set([provider === 'github' ? `Bearer ${CANARY}` : `token ${CANARY}`]));
    }
  });

  it('EFF-TRK-41 a target on another repository or an unconfigured forge is tracker-blocked with no traffic', async () => {
    const { options, traffic } = setup('gitea', {});
    const other = await runVerifier(trackerIssueClosedVerifier(options), { ...request('tracker.issue.closed', 'gitea'), target: 'gitea:someone/else#12' });
    expect(other.observation).toMatchObject({ result: 'unknown', reason: 'tracker-blocked' });
    const internalOnly = { remotes: { ...config.remotes, customer_issue_tracker: undefined, customer_issue_provider: undefined } } as AiwgConfig;
    const github = await runVerifier(trackerIssueClosedVerifier({ ...options, config: internalOnly }), request('tracker.issue.closed', 'github'));
    expect(github.observation).toMatchObject({ result: 'unknown', reason: 'tracker-blocked' });
    const malformed = await runVerifier(trackerIssueClosedVerifier(options), { ...request('tracker.issue.closed', 'gitea'), target: 'gitea:example/repo#0' });
    expect(malformed.observation).toMatchObject({ result: 'unknown', reason: 'malformed-response' });
    expect(traffic.urls).toEqual([]);
  });

  it('EFF-TRK-42 access order: HTTP API first, then the forge CLI; MCP is never offered', async () => {
    const calls: string[][] = [];
    const cliResponse = (status: number, value: unknown, headers = '') => new TextEncoder().encode(`HTTP/2.0 ${status} OK\r\nContent-Type: application/json\r\n${headers}\r\n${JSON.stringify(value)}`);
    const runner = async (args: string[]) => {
      calls.push(args);
      return { stdout: cliResponse(200, { number: 12, state: 'closed', closed_at: RECORDED }), exitCode: 0 };
    };
    const traffic: Traffic = { urls: [], authorizations: [] };
    const withToken = { config, remoteUrls, env, now: () => LATER, cli: { available: true, runner }, fetchImpl: fakeForge('github', { issueState: 'open' }, traffic) };
    expect((await runVerifier(trackerIssueClosedVerifier(withToken), request('tracker.issue.closed', 'github'))).observation.result).toBe('absent');
    expect(calls).toEqual([]);
    const cliOnly = { ...withToken, env: {} };
    const run = await runVerifier(trackerIssueClosedVerifier(cliOnly), request('tracker.issue.closed', 'github'));
    expect(run.observation).toMatchObject({ result: 'present', reason: 'state-match' });
    expect(run.evidence).toMatchObject({ access: 'cli' });
    expect(calls).toEqual([['api', '--include', '--method', 'GET', '--hostname', 'github.com', 'repos/example/repo/issues/12']]);
    // Gitea has no CLI with a raw read API: without credentials it is blocked.
    const gitea = await runVerifier(trackerIssueClosedVerifier({ ...cliOnly }), request('tracker.issue.closed', 'gitea'));
    expect(gitea.observation).toMatchObject({ result: 'unknown', reason: 'tracker-blocked' });
  });

  it('EFF-TRK-43 CLI failures classify from the included status line', async () => {
    expect(parseIncludedResponse(new TextEncoder().encode('HTTP/1.1 403 Forbidden\nX-Ratelimit-Remaining: 0\n\n{}'))).toMatchObject({ status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    const cases: Array<{ stdout: string; exitCode: number; reason: string }> = [
      { stdout: 'HTTP/2.0 401 Unauthorized\r\n\r\n{}', exitCode: 1, reason: 'auth-denied' },
      { stdout: 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\n\r\n{}', exitCode: 1, reason: 'rate-limited' },
      { stdout: '', exitCode: 4, reason: 'auth-denied' },
      { stdout: '', exitCode: 1, reason: 'network-error' },
      { stdout: 'garbage', exitCode: 0, reason: 'malformed-response' },
    ];
    for (const item of cases) {
      const options = { config, remoteUrls, env: {}, now: () => LATER, cli: { available: true, runner: async () => ({ stdout: new TextEncoder().encode(item.stdout), exitCode: item.exitCode }) } };
      expect((await runVerifier(trackerIssueClosedVerifier(options), request('tracker.issue.closed', 'github'))).observation).toMatchObject({ result: 'unknown', reason: item.reason });
    }
  });
});

describe('registration, reconcile and redaction', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => h.cleanup());

  it('EFF-TRK-50 listKinds includes the three tracker kinds with a version and absent support', () => {
    const registry = createBuiltinVerifierRegistry({}, createTrackerVerifiers(setup('gitea', {}).options));
    const refs = registry.listKinds().filter(ref => ref.kind.startsWith('tracker.'));
    expect(refs).toEqual([
      { kind: 'tracker.comment', version: '1.0.0', canReportAbsent: true },
      { kind: 'tracker.issue.closed', version: '1.0.0', canReportAbsent: true },
      { kind: 'tracker.pr.merged', version: '1.0.0', canReportAbsent: true },
    ]);
  });

  it('EFF-TRK-51 reconcile records only the evidence digest; the access canary never reaches records, errors or output', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, commentIntent());
    const outputs: string[] = [];
    for (const state of [
      { comments: [{ id: 3, author: 'delivery-bot', body: `${CANARY} ${marker(intent.effectId)}` }] },
      { comments: [] },
      { fail: { status: 401 } },
      { networkError: true },
    ] as ForgeState[]) {
      const { options } = setup('gitea', state);
      const outcome = await reconcileEffect(ledger, intent.effectId, { verifiers: createBuiltinVerifierRegistry({}, createTrackerVerifiers(options)) });
      outputs.push(JSON.stringify(outcome));
    }
    expect(outputs[0]).toContain('"marker-match"');
    expect(outputs[1]).toContain('"complete-query-no-match"');
    expect(outputs[2]).toContain('"auth-denied"');
    expect(outputs[3]).toContain('"network-error"');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
    const stored = files(h.dir).map(file => readFileSync(file, 'utf8')).join('\n');
    for (const text of [...outputs, stored]) expect(text).not.toContain(CANARY);
    expect(stored).not.toContain('delivery-bot');
  });
});
