import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLiveIssueClient, LiveIssueClient, resolveLiveIssueToken, resolveToken } from '../../../src/issues/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('live issue sync clients', () => {
  it.each(['gitea', 'github'] as const)('names the configured actor and token setup on %s 401s', async provider => {
    const token = 'fixture-rejected-token';
    const fetchFn = vi.fn(async () => jsonResponse({ message: `Rejected ${token}` }, 401));
    const client = new LiveIssueClient({ provider, repo: 'acme/project', token,
      actor: { login: 'fixture-maintainer' }, fetchFn: fetchFn as typeof fetch });
    const error = await client.repositoryRequest('POST', '/issues', { title: 'Test' }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('fixture-maintainer');
    expect(error.message).toContain('remotes.tracker_actor.credential');
    expect(error.message).toContain('aiwg auth secret set');
    expect(error.message).toContain('401');
    expect(error.message).not.toContain(token);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('imports a GitHub issue and comments as an external snapshot', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/repos/acme/project/issues/42/comments')) {
        return jsonResponse([
          {
            id: 99,
            body: 'Remote comment',
            created_at: '2026-05-25T01:00:00.000Z',
            updated_at: '2026-05-25T01:00:00.000Z',
            user: { login: 'octocat' },
          },
        ]);
      }
      return jsonResponse({
        number: 42,
        html_url: 'https://github.com/acme/project/issues/42',
        title: 'Remote issue',
        body: 'Remote body',
        state: 'open',
        labels: [{ name: 'feature' }],
        created_at: '2026-05-25T00:00:00.000Z',
        updated_at: '2026-05-25T00:30:00.000Z',
      });
    });

    const client = new LiveIssueClient({ provider: 'github', repo: 'acme/project', fetchFn: fetchFn as never });
    const snapshot = await client.importIssue('42');

    expect(snapshot).toMatchObject({
      provider: 'github',
      external_id: '42',
      external_url: 'https://github.com/acme/project/issues/42',
      title: 'Remote issue',
      labels: ['feature'],
    });
    expect(snapshot.comments?.[0]).toMatchObject({ external_id: '99', author: 'octocat', body: 'Remote comment' });
  });

  it('exports a new local issue and returns comment id mappings', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.endsWith('/repos/acme/project/issues')) {
        return jsonResponse({
          number: 42,
          html_url: 'https://github.com/acme/project/issues/42',
          title: 'Local issue',
          body: 'Body',
          state: 'open',
          labels: ['sync'],
          created_at: '2026-05-25T00:00:00.000Z',
          updated_at: '2026-05-25T00:00:00.000Z',
        });
      }
      if (init?.method === 'POST' && url.endsWith('/repos/acme/project/issues/42/comments')) {
        return jsonResponse({
          id: 1001,
          body: 'Comment',
          created_at: '2026-05-25T00:01:00.000Z',
          updated_at: '2026-05-25T00:01:00.000Z',
          user: { login: 'operator' },
        });
      }
      if (init?.method === 'GET' && url.endsWith('/repos/acme/project/issues/42/comments')) return jsonResponse([]);
      return jsonResponse({
        number: 42,
        html_url: 'https://github.com/acme/project/issues/42',
        title: 'Local issue',
        body: 'Body',
        state: 'open',
        labels: ['sync'],
        created_at: '2026-05-25T00:00:00.000Z',
        updated_at: '2026-05-25T00:00:00.000Z',
      });
    });
    const client = new LiveIssueClient({ provider: 'github', repo: 'acme/project', fetchFn: fetchFn as never });

    const result = await client.exportIssue({
      provider: 'github',
      local_issue_id: 'LOC-0001',
      external_id: '',
      external_url: null,
      title: 'Local issue',
      body: 'Body',
      status: 'open',
      labels: ['sync'],
      created_at: '2026-05-25T00:00:00.000Z',
      updated_at: '2026-05-25T00:00:00.000Z',
      comments: [
        {
          local_event_id: 'evt-1',
          external_id: null,
          author: 'operator',
          body: 'Comment',
          created_at: '2026-05-25T00:01:00.000Z',
        },
      ],
    });

    expect(result.snapshot.external_id).toBe('42');
    expect(result.commentMappings).toEqual([{ local_event_id: 'evt-1', external_comment_id: '1001' }]);
  });

  it('loads tokens only from provider-specific environment variables', () => {
    expect(resolveToken('gitea', { AIWG_GITEA_TOKEN: 'gitea-token' })).toBe('gitea-token');
    expect(resolveToken('github', { GITHUB_TOKEN: 'github-token' })).toBe('github-token');
  });

  it.each(['gitea', 'github'] as const)('preserves %s legacy environment order behind explicit sources and terminal entry', async provider => {
    const names = provider === 'gitea' ? ['AIWG_GITEA_TOKEN', 'GITEA_TOKEN'] : ['AIWG_GITHUB_TOKEN', 'GITHUB_TOKEN'];
    const environment = { [names[0]]: 'fixture-preferred', [names[1]]: 'fixture-fallback', SELECTED: 'fixture-selected' };
    expect(await resolveLiveIssueToken(provider, {}, { isTTY: false, environment })).toBe('fixture-preferred');
    expect(await resolveLiveIssueToken(provider, {}, { isTTY: false, environment: { [names[1]]: 'fixture-fallback' } })).toBe('fixture-fallback');
    expect(await resolveLiveIssueToken(provider, {}, { isTTY: true, environment, prompt: async () => 'fixture-terminal' })).toBe('fixture-preferred');
    expect(await resolveLiveIssueToken(provider, { env: 'SELECTED' }, { isTTY: false, environment })).toBe('fixture-selected');
    await expect(resolveLiveIssueToken(provider, {}, { isTTY: false, environment: { [names[0]]: '', [names[1]]: 'fixture-fallback' } })).rejects.toThrow('received no key');
  });

  it('shares source precedence and never falls back from an explicitly empty input', async () => {
    const source = { interactive: true, stdin: true, file: 'fixture', store: 'fixture', env: 'EXAMPLE' };
    const dependencies = { isTTY: true, stdinIsTTY: false, prompt: async () => 'fixture-terminal', readStdin: async () => 'fixture-stdin', readFile: async () => 'fixture-file', readStore: async () => 'fixture-store', environment: { EXAMPLE: 'fixture-env', GITHUB_TOKEN: 'fixture-fallback' } };
    expect(await resolveLiveIssueToken('github', source, dependencies)).toBe('fixture-terminal');
    expect(await resolveLiveIssueToken('github', { ...source, interactive: false }, dependencies)).toBe('fixture-stdin');
    expect(await resolveLiveIssueToken('github', { ...source, interactive: false, stdin: false }, dependencies)).toBe('fixture-file');
    expect(await resolveLiveIssueToken('github', { store: 'fixture', env: 'EXAMPLE' }, dependencies)).toBe('fixture-store');
    await expect(resolveLiveIssueToken('github', { stdin: true }, { ...dependencies, readStdin: async () => '' })).rejects.toThrow('received no key');
    expect(await resolveLiveIssueToken('github', {}, { isTTY: false, environment: {} })).toBeUndefined();
    expect(await resolveLiveIssueToken('github', { interactive: true }, { isTTY: true, environment: {}, prompt: async () => 'fixture-terminal' })).toBe('fixture-terminal');
  });

  it.skipIf(process.platform === 'win32')('validates private token files before reading their content', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-live-issue-token-')); roots.push(root);
    const file = path.join(root, 'private');
    writeFileSync(file, 'fixture-private-token', { mode: 0o600 });
    expect(await resolveLiveIssueToken('github', { file }, { isTTY: false })).toBe('fixture-private-token');
    symlinkSync(file, `${file}.link`);
    await expect(resolveLiveIssueToken('github', { file: `${file}.link` }, { isTTY: false })).rejects.toThrow('symlink');
    chmodSync(file, 0o644);
    await expect(resolveLiveIssueToken('github', { file }, { isTTY: false })).rejects.toThrow('group or other access');
  });

  it('retains the synchronous client factory and confines its explicit token to HTTP headers', async () => {
    const token = 'fixture-http-only-token';
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).not.toContain(token);
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      expect(init?.body).toBeUndefined();
      return jsonResponse({ message: `Rejected ${token}` }, 403);
    });
    const client = createLiveIssueClient({ provider: 'github', repo: 'acme/project', token, tokenEnv: { GITHUB_TOKEN: 'wrong-token' }, fetchFn: fetchFn as never });
    expect(client).toBeInstanceOf(LiveIssueClient);
    await expect(client.importIssue('42')).rejects.toThrow('[REDACTED]');
    try { await client.importIssue('42'); } catch (error) { expect(String(error)).not.toContain(token); }
  });

  it.each(['transport', 'http', 'json'] as const)('redacts an exact bearer reflected by %s errors', async failure => {
    const token = 'fixture-secret-bearer';
    const fetchFn = vi.fn(async () => {
      if (failure === 'transport') throw new Error(`Failed ${token}`);
      if (failure === 'json') return { ok: true, json: async () => { throw new Error(`JSON failed ${token}`); } } as Response;
      return new Response(`Authorization: Bearer ${token}; raw ${token}`, { status: 401 });
    });
    const client = new LiveIssueClient({ provider: 'github', repo: 'acme/project', token, fetchFn: fetchFn as never });
    const error = await client.importIssue('42').catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('[REDACTED]');
    expect(String(error)).not.toContain(token);
  });

  it('redacts reflected credentials before returning issue fields and comments', async () => {
    const token = 'fixture-reflected-bearer';
    const fetchFn = vi.fn(async (url: string) => jsonResponse(url.endsWith('/comments')
      ? [{ id: 1, body: token, created_at: '2026-01-01T00:00:00Z' }]
      : { number: 42, title: token, body: token, updated_at: '2026-01-01T00:00:00Z' }));
    const client = new LiveIssueClient({ provider: 'github', repo: 'acme/project', token, fetchFn: fetchFn as never });
    const snapshot = await client.importIssue('42');
    expect(JSON.stringify(snapshot)).not.toContain(token);
    expect(snapshot.title).toBe('[REDACTED]');
    expect(snapshot.comments?.[0].body).toBe('[REDACTED]');
  });
});
