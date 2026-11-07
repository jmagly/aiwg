import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../../src/issues/cli.js';
import { LocalIssueProviderCore } from '../../../src/issues/local.js';
import { issueHandler } from '../../../src/cli/handlers/issues.js';
import { trackerToken } from '../../../src/issues/tracker-policy.js';

describe('issues/cli', () => {
  let root: string;
  let output: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiwg-issue-cli-'));
    output = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      output.push(String(message ?? ''));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['list', '--limit', '3'],
    ['list', '--state', 'all', '--search', 'dispatch ceiling'],
    ['list', '--json'],
    ['ls'],
    ['create', '--title', 'Test', '--body', 'Ordinary body'],
    ['new', '--title', 'Test', '--provider', 'local'],
  ])('fails uninitialized commands with setup guidance: %j', async (...args) => {
    const result = await issueHandler.execute({ args, rawArgs: ['issues', ...args], cwd: root, frameworkRoot: root });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/not initialized.*aiwg issues init/i);
    expect(output).toEqual([]);
    await expect(readFile(join(root, '.aiwg/issues/index/issues.index.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, '.aiwg/issues/config.json'), 'utf8')).rejects.toThrow();
  });

  it('distinguishes successful empty local searches in text and JSON', async () => {
    await main(['init'], root);
    await main(['new', '--title', 'Existing issue'], root);
    output = [];
    await main(['list', '--search', 'no matching title'], root);
    expect(output).toEqual(['No matching issues found.']);
    output = [];
    await main(['list', '--search', 'no matching title', '--json'], root);
    expect(JSON.parse(output[0])).toEqual({ issues: [], nextCursor: null });
  });

  it('never treats local storage as a duplicate query of the configured external tracker', async () => {
    await main(['init'], root);
    await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify({ version: '1.0', remotes: {
      issue_tracker: 'https://tracker.example.test/acme/project.git', issue_provider: 'gitea',
      tracker_actor: { login: 'fixture-maintainer' },
    } }));
    const fetchFn = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'));
    await expect(main(['list', '--search', 'dispatch ceiling'], root))
      .rejects.toThrow(/configured external tracker.*tracker tools/i);
    await main(['list', '--provider', 'local', '--json'], root);
    expect(JSON.parse(output.at(-1)!)).toEqual({ issues: [], nextCursor: null });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports actor setup on an external create 401 without initializing local storage', async () => {
    await mkdir(join(root, '.aiwg'));
    await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify({ version: '1.0', remotes: {
      issue_tracker: 'https://tracker.example.test/acme/project.git', issue_provider: 'gitea',
      tracker_actor: { login: 'fixture-maintainer' },
    } }));
    vi.stubEnv('AIWG_GITEA_TOKEN', undefined);
    vi.stubEnv('GITEA_TOKEN', undefined);
    const fetchFn = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(JSON.stringify(String(url).endsWith('/user') ? { message: 'token required' } : []),
        { status: String(url).endsWith('/user') ? 401 : 200 }));
    const error = await main(['create', '--title', 'Test', '--body', 'Ordinary body'], root).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/fixture-maintainer.*remotes\.tracker_actor\.credential/);
    expect(error.message).toContain('aiwg auth secret set');
    expect(fetchFn.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    await expect(readFile(join(root, '.aiwg/issues/config.json'), 'utf8')).rejects.toThrow();
  });

  it.each([{ env: 'FIXTURE_ACTOR_TOKEN' }, { store: 'fixture-actor-token' }])(
    'names the actor and setup when its configured credential is unavailable: %j', async credential => {
      await expect(trackerToken('gitea', { login: 'fixture-maintainer', credential }, {}, {
        environment: {}, isTTY: false, readStore: async () => null,
      })).rejects.toThrow(/fixture-maintainer.*aiwg auth secret set.*remotes\.tracker_actor\.credential/);
    },
  );

  it('initializes, creates, lists, comments, shows, closes, and rebuilds local issues', async () => {
    await main(['init', '--prefix', 'DOCS'], root);
    await main(['new', '--title', 'Fix docs', '--body', 'Acceptance criteria'], root);
    await main(['new', '--title', 'Triage import flow', '--body', 'Migration note'], root);
    await main(['list', '--status', 'open'], root);
    await main(['list', '--search', 'import'], root);

    expect(output.join('\n')).toContain('Initialized local issues with prefix DOCS');
    expect(output.join('\n')).toContain('Created DOCS-0001: Fix docs');
    expect(output.join('\n')).toContain('Created DOCS-0002: Triage import flow');
    expect(output.join('\n')).toContain('DOCS-0001\topen');
    const searchOutput = output.at(-1) ?? '';
    expect(searchOutput).toContain('DOCS-0002\topen');
    expect(searchOutput).not.toContain('DOCS-0001\topen');

    await main(['comment', 'DOCS-0001', '--body', 'Started'], root);
    await main(['show', 'DOCS-0001', '--comments', 'last:1'], root);
    await main(['close', 'DOCS-0001', '--reason', 'Done'], root);
    await main(['index', 'rebuild'], root);

    const events = await readFile(join(root, '.aiwg', 'issues', 'events', 'DOCS-0001.jsonl'), 'utf-8');
    expect(events).toContain('"type":"comment"');
    expect(events).toContain('"type":"closed"');
    expect(output.join('\n')).toContain('# DOCS-0001: Fix docs');
    expect(output.join('\n')).toContain('Closed DOCS-0001');
    expect(output.join('\n')).toContain('Local issue index ready (2 issues)');
  });

  it('reads issue and comment body files', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'body.md'), 'Body from file', 'utf-8');
    await writeFile(join(root, 'comment.md'), 'Comment from file', 'utf-8');

    await main(['init', '--prefix', 'FILE'], root);
    await main(['new', '--title', 'File body', '--body-file', join(root, 'body.md')], root);
    await main(['comment', 'FILE-0001', '--body-file', join(root, 'comment.md')], root);

    const body = await readFile(join(root, '.aiwg', 'issues', 'items', 'FILE-0001.md'), 'utf-8');
    expect(body).toContain('Body from file');
    const shown = await readFile(join(root, '.aiwg', 'issues', 'events', 'FILE-0001.jsonl'), 'utf-8');
    expect(shown).toContain('body_path');
  });

  it('passes --force through to local issue index rebuilding', async () => {
    await main(['init'], root);
    const rebuild = vi.spyOn(LocalIssueProviderCore.prototype, 'rebuildIssueIndex');
    await main(['index', 'rebuild', '--force'], root);
    expect(rebuild).toHaveBeenCalledWith({ force: true });
  });

  it('plans drafts before writing and preserves the authorization no-write gate', async () => {
    await main(['plan', '--title', 'Safe issue', '--body', 'Clarify the empty state.'], root);
    const safePlan = JSON.parse(output.at(-1) ?? '{}');
    expect(safePlan.disposition).toBe('single');
    await expect(main([
      'new', '--title', 'Provider instructions', '--body', 'Update AGENTS.md for the project.',
    ], root)).rejects.toThrow(/requires explicit policy authorization/);
    await expect(readFile(join(root, '.aiwg', 'issues', 'index', 'issues.index.json'), 'utf8'))
      .rejects.toThrow();
  });

  it('creates linked local segments after digest-bound authorization', async () => {
    const body = [
      '## Goal', '', 'Improve setup.', '',
      '## Acquisition', '', 'Run npm install -g aiwg during setup.', '',
      '## Wiring', '', 'Update AGENTS.md for the configured provider.', '',
      '## Acceptance', '', '- [ ] Both independently scoped changes are tracked.',
    ].join('\n');
    await main(['plan', '--title', 'Improve setup', '--body', body, '--label', 'priority:P1-high'], root);
    const plan = JSON.parse(output.at(-1) ?? '{}');
    expect(plan.disposition).toBe('split-authorization-required');

    await main(['init'], root);
    output = [];
    await main([
      'new', '--title', 'Improve setup', '--body', body,
      '--authorize-policy', plan.digest,
      '--label', 'priority:P1-high',
    ], root);
    const result = JSON.parse(output.at(-1) ?? '{}');
    expect(result.status).toBe('created');
    expect(result.created).toHaveLength(2);
    const index = JSON.parse(await readFile(join(root, '.aiwg', 'issues', 'index', 'issues.index.json'), 'utf8'));
    expect(index.issues).toHaveLength(2);
    expect(index.issues.every((issue: { labels: string[] }) => issue.labels.includes('priority:P1-high'))).toBe(true);
    const dependent = await readFile(join(root, '.aiwg', 'issues', 'items', `${result.created[1].id}.md`), 'utf8');
    expect(dependent).toContain(`parent: ${result.created[0].id}`);
  });

  it('rejects non-local providers', async () => {
    await expect(main(['list', '--provider', 'gitea'], root)).rejects.toThrow(/local issue storage only/);
  });

  it('rejects Fortemi/backend selectors for local issue search', async () => {
    await main(['init', '--prefix', 'BOUND'], root);
    await main(['new', '--title', 'Fortemi boundary', '--body', 'Keep issue search local'], root);

    await expect(
      main(['list', '--search', 'Fortemi', '--backend', 'fortemi-core'], root),
    ).rejects.toThrow(/--backend is not supported/);
  });

  it('resolves private token sources for live import and export without printing reflected credentials', async () => {
    const token = 'fixture-live-cli-bearer';
    const file = join(root, 'private-token');
    await writeFile(file, token, { mode: 0o600 });
    const fetchFn = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).not.toContain(token);
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      return new Response(JSON.stringify(String(input).endsWith('/comments') ? [] : {
        number: 42, html_url: 'https://example.test/acme/project/issues/42', title: `Remote ${token}`,
        body: `Reflected ${token}`, updated_at: '2026-01-01T00:00:00Z',
      }), { headers: { 'content-type': 'application/json' } });
    });
    await main(['init', '--prefix', 'LIVE'], root);
    await main(['import', '--from', 'github', '--live', '--repo', 'acme/project', '--external-id', '42', '--token-file', file, '--json'], root);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(output.join('\n')).toContain('[REDACTED]');
    expect(output.join('\n')).not.toContain(token);
    expect(await readFile(join(root, '.aiwg', 'issues', 'items', 'LIVE-0001.md'), 'utf8')).not.toContain(token);

    fetchFn.mockImplementation(async (_input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      return new Response(`Rejected ${token}`, { status: 403 });
    });
    const error = await main(['export', 'LIVE-0001', '--to', 'github', '--live', '--repo', 'acme/project', '--force', '--token-file', file], root).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('[REDACTED]');
    expect(String(error)).not.toContain(token);
    expect(output.join('\n')).not.toContain(token);
  });

  it('refuses headless interactive token entry and names the live token sources', async () => {
    vi.stubEnv('AIWG_GITHUB_TOKEN', undefined);
    vi.stubEnv('GITHUB_TOKEN', undefined);
    // With no source and no provider variable, live requests stay unauthenticated
    // (public repositories), so only an explicit interactive request can fail here.
    await expect(main(['import', '--from', 'github', '--live', '--repo', 'acme/project', '--external-id', '42', '--token-interactive'], root))
      .rejects.toThrow(/--token-stdin.*--token-file.*--token-store.*--token-env/);
  });
});
