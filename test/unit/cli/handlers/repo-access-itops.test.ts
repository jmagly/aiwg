import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { repoAccessHandler } from '../../../../src/cli/handlers/repo-access.js';
import { loadRepoAccessManifest } from '../../../../src/policy/repo-access.js';

let root: string;
let log: ReturnType<typeof vi.spyOn>;
const run = (args: string[], cwd = root) => repoAccessHandler.execute({
  args, rawArgs: ['repo-access', ...args], cwd, frameworkRoot: root,
});
const output = () => log.mock.calls.map(([line]) => String(line)).join('\n');

beforeEach(async () => {
  vi.stubEnv('AIWG_WORKSPACE', '');
  vi.stubEnv('AIWG_ARTIFACTS_PATH', '');
  root = await mkdtemp(join(tmpdir(), 'repo-access-itops-'));
  await cp(resolve('test/fixtures/repo-access/itops'), root, { recursive: true });
  await mkdir(join(root, 'repos/aiwg.io/.git'), { recursive: true });
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('itops workspace spec (#4282)', () => {
  it('lists both spec sources and checks read/write while denying ungranted actions', async () => {
    expect((await run(['list'])).exitCode).toBe(0);
    expect(output()).toContain('aiwg.io');
    expect(output()).toContain('docs');
    expect((await run(['check', '--path', 'repos/aiwg.io', '--action', 'write'])).exitCode).toBe(0);
    expect((await run(['check', '--path', 'repos/aiwg.io', '--action', 'push'])).exitCode).toBe(1);
    expect((await run(['check', '--path', 'repos/docs', '--action', 'write'])).exitCode).toBe(1);
    expect((await run(['check', '--path', 'repos/unknown', '--action', 'read'])).exitCode).toBe(1);
  });

  it('discovers the control spec from a nested member and AIWG_WORKSPACE', () => {
    expect(loadRepoAccessManifest(join(root, 'repos/aiwg.io')).workspaceProjectRoot).toBe(root);
    vi.stubEnv('AIWG_WORKSPACE', root);
    expect(loadRepoAccessManifest(tmpdir()).workspaceProjectRoot).toBe(root);
  });

  it('prints the exact edits to the active spec files without creating a competing manifest', async () => {
    const workspace = join(root, 'config/workspace.yaml');
    const routing = join(root, 'config/repository-routing.yaml');
    const before = await Promise.all([readFile(workspace, 'utf8'), readFile(routing, 'utf8')]);
    const result = await run(['add', '--path', 'repos/marketing', '--name', 'marketing', '--allow', 'read,write']);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(workspace);
    expect(result.message).toContain(routing);
    expect(result.message).toContain('repos[]');
    expect(result.message).toContain('repositories[]');
    expect(result.message).toContain('name: "marketing"');
    expect(result.message).toContain('path: "repos/marketing"');
    expect(await Promise.all([readFile(workspace, 'utf8'), readFile(routing, 'utf8')])).toEqual(before);
    await expect(readFile(join(root, '.aiwg/aiwg.config'))).rejects.toThrow();
  });

  it('audits git directories and worktree git files under repos/', async () => {
    await mkdir(join(root, 'repos/unlisted'), { recursive: true });
    await writeFile(join(root, 'repos/unlisted/.git'), 'gitdir: /synthetic/worktree');
    expect((await run(['audit'])).exitCode).toBe(1);
    expect(output()).toContain('- repos/unlisted');
    expect(output()).not.toMatch(/^\s+- (?:repos\/)?aiwg.io$/m);
    await rm(join(root, 'repos/unlisted'), { recursive: true });
    expect((await run(['audit'])).exitCode).toBe(0);
  });

  it('honors explicit restrictions in both files without broadening duplicate permissions', async () => {
    await writeFile(join(root, 'config/workspace.yaml'), [
      'apiVersion: workspace.aiwg.io/v1', 'kind: WorkspaceSpec', 'repos:',
      '  - name: aiwg.io', '    path: repos/aiwg.io', '    allowed: [read]',
    ].join('\n'));
    expect((await run(['check', '--path', 'repos/aiwg.io', '--action', 'write'])).exitCode).toBe(1);
  });

  it.each(['repos: broken', 'repos: [{name: bad}]', 'repos: [{name: bad, path: repos/bad, allowed: [teleport]}]'])(
    'fails closed on malformed spec entries: %s', async (repos) => {
      await writeFile(join(root, 'config/workspace.yaml'), `apiVersion: workspace.aiwg.io/v1\nkind: WorkspaceSpec\n${repos}\n`);
      expect((await run(['list'])).exitCode).toBe(2);
    },
  );


  it('refuses removal against the managed spec and reports requested actions for add', async () => {
    const removed = await run(['remove', '--name', 'aiwg.io']);
    expect(removed.exitCode).toBe(2);
    expect(removed.message).toContain('Remove the entry named "aiwg.io"');
    const added = await run(['add', '--path', '../new', '--name', 'new', '--allow', 'read,push'], join(root, 'repos/aiwg.io'));
    expect(added.exitCode).toBe(2);
    expect(added.message).toContain('Requested actions: read, push');
    expect(added.message).toContain('path: "repos/new"');
  });

  it('resolves a member_of reference to the itops workspace', async () => {
    const member = join(root, 'external');
    await mkdir(join(member, '.aiwg'), { recursive: true });
    await writeFile(join(member, '.aiwg/aiwg.config'), JSON.stringify({ workspace: { member_of: root } }));
    expect(loadRepoAccessManifest(member).source).toBe('workspace-spec');
  });

  it('loads a workspace without optional routing', async () => {
    await rm(join(root, 'config/repository-routing.yaml'));
    expect(loadRepoAccessManifest(root).repos).toHaveLength(1);
  });

  it.each(['repositories: broken', '[]', ': broken yaml: ['])('rejects malformed routing: %s', async (routing) => {
    await writeFile(join(root, 'config/repository-routing.yaml'), routing);
    expect((await run(['list'])).exitCode).toBe(2);
  });

  it.each(['apiVersion: other\nkind: WorkspaceSpec\nrepos: []', '[]', 'apiVersion: workspace.aiwg.io/v1\nkind: Other\nrepos: []'])(
    'rejects an unsupported workspace document: %s', async (workspace) => {
      await writeFile(join(root, 'config/workspace.yaml'), workspace);
      expect((await run(['list'])).exitCode).toBe(2);
    },
  );

  it('rejects conflicting names and paths rather than authorizing both', async () => {
    await writeFile(join(root, 'config/repository-routing.yaml'), 'repositories: [{name: aiwg.io, path: repos/elsewhere}]');
    expect((await run(['list'])).exitCode).toBe(2);
    await writeFile(join(root, 'config/repository-routing.yaml'), 'repositories: [{name: other, path: repos/aiwg.io}]');
    expect((await run(['list'])).exitCode).toBe(2);
  });

  it('intersects routing restrictions and rejects non-object entries', async () => {
    await writeFile(join(root, 'config/repository-routing.yaml'), 'repositories: [{name: aiwg.io, path: repos/aiwg.io, allowed: [read]}]');
    expect((await run(['check', '--path', 'repos/aiwg.io', '--action', 'write'])).exitCode).toBe(1);
    await writeFile(join(root, 'config/repository-routing.yaml'), 'repositories: [null]');
    expect((await run(['list'])).exitCode).toBe(2);
  });

  it('accepts action aliases and reports a root-relative registration', async () => {
    await writeFile(join(root, 'config/repository-routing.yaml'), [
      'repositories:', '  - name: docs', '    path: repos/docs', '    actions: [read]',
      '  - name: other', '    path: repos/other', '    permissions: [read]',
    ].join('\n'));
    expect(loadRepoAccessManifest(root).repos).toHaveLength(3);
    const added = await run(['add', '--path', '.', '--name', 'workspace', '--allow', 'read,write']);
    expect(added.message).toContain('path: "."');
  });

  it('uses the explicit target for spec mutation guidance', async () => {
    const result = await run(['add', '--target', root, '--path', 'repos/new', '--name', 'new', '--allow', 'read,write'], tmpdir());
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(join(root, 'config/workspace.yaml'));
    expect(result.message).toContain('path: "repos/new"');
  });

  it('keeps canonical config authoritative over the spec', async () => {
    await mkdir(join(root, '.aiwg'));
    await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify({
      repos: [{ name: 'canonical', path: 'repos/aiwg.io', allowed: ['read'] }],
    }));
    expect(loadRepoAccessManifest(root).source).toBe('workspace-config');
    expect((await run(['check', '--path', 'repos/aiwg.io', '--action', 'write'])).exitCode).toBe(1);
  });
});
