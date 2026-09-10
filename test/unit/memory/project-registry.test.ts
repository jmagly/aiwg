import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('project memory registry (#1750)', () => {
  let tmp: string;
  let workspace: string;
  let ownsTmp = false;
  const environmentKeys = ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_PROJECT_MEMORY_HOME'];
  let originalEnvironment: Array<string | undefined>;

  beforeEach(async () => {
    ownsTmp = false;
    originalEnvironment = environmentKeys.map(key => process.env[key]);
    for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) {
      vi.stubEnv(key, undefined);
    }
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-project-memory-'));
    ownsTmp = true;
    workspace = path.join(tmp, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', path.join(tmp, 'home', '.aiwg', 'projects'));
  });

  afterEach(async () => {
    try {
      const { resetStorage } = await import('../../../src/storage/index.js');
      resetStorage();
    } finally {
      try {
        if (ownsTmp) {
          await fs.rm(tmp, { recursive: true, force: true });
          await expect(fs.stat(tmp)).rejects.toMatchObject({ code: 'ENOENT' });
          ownsTmp = false;
        }
      } finally {
        vi.unstubAllEnvs();
        environmentKeys.forEach((key, index) => {
          // Report only equality, never inherited setting contents.
          expect(process.env[key] === originalEnvironment[index], `${key} restored`).toBe(true);
        });
      }
    }
  });

  it.each([
    ['git@EXAMPLE.test:Org/Repo', 'example.test/org/repo'],
    ['https://EXAMPLE.test/Org/Repo/', 'example.test/org/repo'],
    ['ssh://git@EXAMPLE.test/Org/Repo.git', 'example.test/org/repo'],
    ['  LOCAL/Repo.git  ', 'local/repo'], ['LOCAL/Repo', 'local/repo'], ['single', 'single'],
  ])('normalizes remote %s to %s', async (input, expected) => {
    const { normalizeGitRemote } = await import('../../../src/memory/project-registry.js');
    expect(normalizeGitRemote(input)).toBe(expected);
  });

  it('computes default home paths without reading or creating user memory', async () => {
    const { projectMemoryHome, projectMemoryManifestPath, projectMemoryIndexPath } = await import('../../../src/memory/project-registry.js');
    const ownedHome = process.env.AIWG_PROJECT_MEMORY_HOME;
    vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', undefined);
    try {
      const expected = path.join(os.homedir(), '.aiwg/projects');
      expect(projectMemoryHome()).toBe(expected);
      expect(projectMemoryManifestPath()).toBe(path.join(expected, 'manifest.json'));
      expect(projectMemoryIndexPath()).toBe(path.join(expected, 'index/manifest-index.json'));
    } finally { vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', ownedHome); }
    expect(await fs.readdir(tmp)).toEqual(['workspace']);
  });

  it('expands stored tilde paths during read without accessing their targets', async () => {
    const { readProjectMemoryManifest, projectMemoryManifestPath } = await import('../../../src/memory/project-registry.js');
    const manifestPath = projectMemoryManifestPath();
    const projects = ['~', '~/owned-path-label'].map((memoryRoot, index) => ({ id: `p${index}`, name: `p${index}`,
      memoryRoot, workspaceRoots: [memoryRoot], gitRemotes: [], metadata: {}, registeredAt: 'fixed', updatedAt: 'fixed' }));
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const bytes = JSON.stringify({ version: 1, projects });
    await fs.writeFile(manifestPath, bytes);
    const expectedPaths = [os.homedir(), path.join(os.homedir(), 'owned-path-label')];
    expect(await readProjectMemoryManifest()).toEqual({ version: 1, projects: projects.map((entry, i) => ({ ...entry,
      memoryRoot: expectedPaths[i], workspaceRoots: [expectedPaths[i]] })) });
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(bytes);
  });

  it('uses scoped current workspace and empty-ID fallback with short remote metadata', async () => {
    const { registerProjectMemory } = await import('../../../src/memory/project-registry.js');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    try {
      const entry = await registerProjectMemory({ id: ' !!! ', gitRemotes: ['single'] });
      expect(entry).toMatchObject({ id: 'project', name: 'workspace', workspaceRoots: [workspace],
        gitRemotes: ['single'], metadata: {}, memoryRoot: path.join(tmp, 'home/.aiwg/projects/project/.aiwg') });
    } finally { cwd.mockRestore(); }
  });

  it('selects a matching member of a project with unrelated workspace roots', async () => {
    const { registerProjectMemory, lookupProjectMemory } = await import('../../../src/memory/project-registry.js');
    await registerProjectMemory({ id: 'multi', workspaceRoot: path.join(tmp, 'unrelated'), gitRemotes: [] });
    const entry = await registerProjectMemory({ id: 'multi', workspaceRoot: workspace, gitRemotes: [] });
    expect(await lookupProjectMemory({ workspaceRoot: path.join(workspace, 'nested') })).toEqual({
      status: 'found', entry, matchedBy: 'workspaceRoot' });
  });

  it.each([
    '{"version":2,"projects":[]}', '{"version":"1","projects":[]}',
    '{"version":1}', '{"version":1,"projects":{}}',
  ])('rejects invalid manifest envelope %s without mutation', async bytes => {
    const { readProjectMemoryManifest, projectMemoryManifestPath, projectMemoryIndexPath } = await import('../../../src/memory/project-registry.js');
    const manifestPath = projectMemoryManifestPath();
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, bytes);
    await expect(readProjectMemoryManifest()).rejects.toThrow(`${manifestPath}: expected project memory manifest version 1`);
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(bytes);
    await expect(fs.stat(projectMemoryIndexPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves invalid JSON and leaves the index absent', async () => {
    const { readProjectMemoryManifest, projectMemoryManifestPath, projectMemoryIndexPath } = await import('../../../src/memory/project-registry.js');
    const manifestPath = projectMemoryManifestPath();
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, '{invalid json');
    await expect(readProjectMemoryManifest()).rejects.toBeInstanceOf(SyntaxError);
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe('{invalid json');
    await expect(fs.stat(projectMemoryIndexPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('normalizes stored entries and rebuilds the index without rewriting the manifest', async () => {
    const { readProjectMemoryManifest, writeProjectMemoryIndex, projectMemoryManifestPath, projectMemoryIndexPath } = await import('../../../src/memory/project-registry.js');
    const manifestPath = projectMemoryManifestPath();
    const memoryRoot = path.join(tmp, 'inert-memory');
    const fields = { id: 'demo', name: 'Stored', memoryRoot, registeredAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' };
    const bare = { ...fields, id: 'bare' };
    const bytes = JSON.stringify({ version: 1, projects: [{ ...fields,
      workspaceRoots: [workspace, `${workspace}/.`, ''],
      gitRemotes: [' git@EXAMPLE.test:Org/Demo.git ', 'https://example.test/org/demo.git', ''] }, bare] });
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, bytes);
    expect(await readProjectMemoryManifest()).toEqual({ version: 1, projects: [
      { ...fields, workspaceRoots: [workspace], gitRemotes: ['git@EXAMPLE.test:Org/Demo.git'], metadata: {} },
      { ...bare, workspaceRoots: [], gitRemotes: [], metadata: {} },
    ] });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-10T14:00:00.000Z'));
      const expected = { version: 1, generatedAt: '2026-09-10T14:00:00.000Z',
        byProjectId: { demo: 'demo', bare: 'bare' }, byWorkspaceRoot: { [workspace]: ['demo'] },
        byGitRemote: { 'example.test/org/demo': ['demo'] } };
      expect(await writeProjectMemoryIndex()).toEqual(expected);
      expect(JSON.parse(await fs.readFile(projectMemoryIndexPath(), 'utf8'))).toEqual(expected);
      await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(bytes);
      await expect(fs.stat(memoryRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.useRealTimers(); }
  });

  it('registers a project with private .aiwg layout and indexed metadata', async () => {
    const {
      projectMemoryIndexPath,
      projectMemoryManifestPath,
      registerProjectMemory,
    } = await import('../../../src/memory/project-registry.js');

    const entry = await registerProjectMemory({
      id: 'demo',
      name: 'demo',
      workspaceRoot: workspace,
      gitRemotes: ['git@git.integrolabs.net:roctinam/demo.git'],
    });

    expect(entry.memoryRoot).toBe(path.join(process.env.AIWG_PROJECT_MEMORY_HOME!, 'demo', '.aiwg'));
    await expect(fs.stat(path.join(entry.memoryRoot, 'aiwg.config'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(entry.memoryRoot, 'memory'))).resolves.toBeTruthy();

    const manifest = JSON.parse(await fs.readFile(projectMemoryManifestPath(), 'utf-8'));
    expect(manifest.projects[0]).toMatchObject({
      id: 'demo',
      name: 'demo',
      workspaceRoots: [workspace],
      metadata: { owner: 'roctinam', repo: 'demo' },
    });

    const index = JSON.parse(await fs.readFile(projectMemoryIndexPath(), 'utf-8'));
    expect(index.byProjectId.demo).toBe('demo');
    expect(index.byWorkspaceRoot[workspace]).toEqual(['demo']);
    expect(index.byGitRemote['git.integrolabs.net/roctinam/demo']).toEqual(['demo']);
  });

  it('preserves registration history, files and merged mappings on re-registration', async () => {
    const { registerProjectMemory, projectMemoryManifestPath, projectMemoryIndexPath } = await import('../../../src/memory/project-registry.js');
    const memoryRoot = path.join(tmp, 'owned-memory', '.aiwg');
    const remote = 'git@example.test:org/demo.git';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
      const initial = { id: 'demo-project', name: 'Initial', workspaceRoots: [workspace],
        gitRemotes: [remote, 'git@example.test:org/legacy.git'], memoryRoot, metadata: { owner: 'custom', repo: 'demo', label: 'first' },
        registeredAt: '2026-09-10T12:00:00.000Z', updatedAt: '2026-09-10T12:00:00.000Z' };
      expect(await registerProjectMemory({ id: ' Demo Project ', name: 'Initial', workspaceRoot: workspace,
        memoryRoot, gitRemotes: [remote, 'https://example.test/org/demo.git', '', 'git@example.test:org/legacy.git'],
        metadata: { owner: 'custom', label: 'first' } })).toEqual(initial);
      expect(JSON.parse(await fs.readFile(projectMemoryManifestPath(), 'utf8'))).toEqual({ version: 1, projects: [initial] });
      const config = path.join(memoryRoot, 'aiwg.config');
      expect(JSON.parse(await fs.readFile(config, 'utf8'))).toEqual({ version: '1', projectMemory: { private: true } });
      await fs.writeFile(config, '{"owned":"preserve"}\n');
      await fs.writeFile(path.join(memoryRoot, 'memory/note.md'), 'preserve note');
      const secondWorkspace = path.join(tmp, 'second');
      vi.setSystemTime(new Date('2026-09-10T13:00:00.000Z'));
      const updated = { ...initial, name: 'Updated', workspaceRoots: [secondWorkspace, workspace].sort(),
        gitRemotes: [remote, 'git@example.test:org/extra.git', 'git@example.test:org/legacy.git'], metadata: { owner: 'org', repo: 'demo', label: 'second' },
        updatedAt: '2026-09-10T13:00:00.000Z' };
      const request = { id: 'demo-project', name: 'Updated', workspaceRoot: secondWorkspace, memoryRoot,
        gitRemotes: ['https://example.test/org/demo.git', 'git@example.test:org/extra.git'], metadata: { repo: 'demo', label: 'second' } };
      expect(await registerProjectMemory(request)).toEqual(updated);
      expect(await registerProjectMemory(request)).toEqual(updated);
      expect(JSON.parse(await fs.readFile(projectMemoryManifestPath(), 'utf8'))).toEqual({ version: 1, projects: [updated] });
      expect(JSON.parse(await fs.readFile(projectMemoryIndexPath(), 'utf8'))).toEqual({ version: 1,
        generatedAt: '2026-09-10T13:00:00.000Z', byProjectId: { 'demo-project': 'demo-project' },
        byWorkspaceRoot: { [workspace]: ['demo-project'], [secondWorkspace]: ['demo-project'] },
        byGitRemote: { 'example.test/org/demo': ['demo-project'], 'example.test/org/extra': ['demo-project'], 'example.test/org/legacy': ['demo-project'] } });
      await expect(fs.readFile(config, 'utf8')).resolves.toBe('{"owned":"preserve"}\n');
      await expect(fs.readFile(path.join(memoryRoot, 'memory/note.md'), 'utf8')).resolves.toBe('preserve note');
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])('derives a stable default project ID with remote=%s', async useRemote => {
    const { registerProjectMemory, projectMemoryManifestPath } = await import('../../../src/memory/project-registry.js');
    const seed = useRemote ? 'example.test/org/demo' : workspace;
    const expectedId = `workspace-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
    const request = { workspaceRoot: workspace, gitRemotes: useRemote ? ['git@example.test:org/demo.git'] : [] };
    const first = await registerProjectMemory(request);
    expect(first.id).toBe(expectedId);
    expect(first.name).toBe('workspace');
    expect(first.memoryRoot).toBe(path.join(tmp, 'home/.aiwg/projects', expectedId, '.aiwg'));
    expect((await registerProjectMemory(request)).id).toBe(expectedId);
    const manifest = JSON.parse(await fs.readFile(projectMemoryManifestPath(), 'utf8'));
    expect(manifest.projects.map((entry: { id: string }) => entry.id)).toEqual([expectedId]);
  });

  it('looks up project memory by active workspace path and git remote', async () => {
    const { lookupProjectMemory, registerProjectMemory } = await import('../../../src/memory/project-registry.js');
    await registerProjectMemory({
      id: 'demo',
      workspaceRoot: workspace,
      gitRemotes: ['https://git.integrolabs.net/roctinam/demo.git'],
    });

    const byPath = await lookupProjectMemory({ workspaceRoot: path.join(workspace, 'nested') });
    expect(byPath.status).toBe('found');
    if (byPath.status === 'found') expect(byPath.matchedBy).toBe('workspaceRoot');

    const byRemote = await lookupProjectMemory({ gitRemote: 'git@git.integrolabs.net:roctinam/demo.git' });
    expect(byRemote.status).toBe('found');
    if (byRemote.status === 'found') expect(byRemote.matchedBy).toBe('gitRemote');
  });

  it('reports missing and ambiguous mappings', async () => {
    const { lookupProjectMemory, registerProjectMemory } = await import('../../../src/memory/project-registry.js');
    expect((await lookupProjectMemory({ workspaceRoot: workspace })).status).toBe('missing');

    await registerProjectMemory({
      id: 'one',
      workspaceRoot: workspace,
      gitRemotes: ['git@example.test:org/repo.git'],
    });
    await registerProjectMemory({
      id: 'two',
      workspaceRoot: workspace,
      gitRemotes: ['git@example.test:org/repo.git'],
    });

    expect((await lookupProjectMemory({ workspaceRoot: workspace })).status).toBe('ambiguous');
    expect((await lookupProjectMemory({ gitRemote: 'https://example.test/org/repo.git' })).status).toBe('ambiguous');
  });

  it('selects the nearest workspace and reports only equally near candidates', async () => {
    const { lookupProjectMemory, registerProjectMemory } = await import('../../../src/memory/project-registry.js');
    const nested = path.join(workspace, 'nested');
    await registerProjectMemory({ id: 'parent', workspaceRoot: workspace, gitRemotes: [] });
    const child = await registerProjectMemory({ id: 'child', workspaceRoot: nested, gitRemotes: [] });
    const active = path.join(nested, 'leaf');
    expect(await lookupProjectMemory({ workspaceRoot: active })).toEqual({
      status: 'found', entry: child, matchedBy: 'workspaceRoot',
    });
    const peer = await registerProjectMemory({ id: 'peer', workspaceRoot: nested, gitRemotes: [] });
    expect(await lookupProjectMemory({ workspaceRoot: active })).toEqual({
      status: 'ambiguous', reason: `Multiple project memory entries match workspace '${active}'`,
      entries: [child, peer],
    });
  });

  it('honors explicit ID before path and remote, including an unknown ID', async () => {
    const { lookupProjectMemory, registerProjectMemory } = await import('../../../src/memory/project-registry.js');
    const one = await registerProjectMemory({ id: 'one', workspaceRoot: workspace, gitRemotes: [] });
    await registerProjectMemory({ id: 'two', workspaceRoot: path.join(tmp, 'other'), gitRemotes: ['git@example.test:org/two.git'] });
    const otherSelectors = { workspaceRoot: path.join(tmp, 'other'), gitRemote: 'https://example.test/org/two.git' };
    expect(await lookupProjectMemory({ id: 'one', ...otherSelectors })).toEqual({ status: 'found', entry: one, matchedBy: 'id' });
    expect(await lookupProjectMemory({ id: 'absent', ...otherSelectors })).toEqual({ status: 'missing', reason: "No project memory entry with id 'absent'" });
  });

  it('rejects sibling path prefixes and falls back to the exact remote match', async () => {
    const { lookupProjectMemory, registerProjectMemory } = await import('../../../src/memory/project-registry.js');
    const entry = await registerProjectMemory({ id: 'demo', workspaceRoot: workspace, gitRemotes: ['git@example.test:org/demo.git'] });
    const sibling = `${workspace}-sibling`;
    const missing = { status: 'missing', reason: 'No project memory entry matched the supplied workspace or remote metadata' };
    expect(await lookupProjectMemory({ workspaceRoot: sibling })).toEqual(missing);
    expect(await lookupProjectMemory({})).toEqual(missing);
    expect(await lookupProjectMemory({ gitRemote: 'https://example.test/org/missing.git' })).toEqual(missing);
    expect(await lookupProjectMemory({ workspaceRoot: sibling, gitRemote: 'https://example.test/org/demo.git' })).toEqual({ status: 'found', entry, matchedBy: 'gitRemote' });
  });

  it('preserves workspace precedence and returns exact remote ambiguity candidates', async () => {
    const { lookupProjectMemory, registerProjectMemory } = await import('../../../src/memory/project-registry.js');
    const one = await registerProjectMemory({ id: 'one', workspaceRoot: workspace, gitRemotes: ['git@example.test:org/shared.git'] });
    const two = await registerProjectMemory({ id: 'two', workspaceRoot: path.join(tmp, 'other'), gitRemotes: ['https://example.test/org/shared.git'] });
    const remote = 'https://example.test/org/shared.git';
    expect(await lookupProjectMemory({ workspaceRoot: workspace, gitRemote: remote })).toEqual({ status: 'found', entry: one, matchedBy: 'workspaceRoot' });
    expect(await lookupProjectMemory({ gitRemote: remote })).toEqual({ status: 'ambiguous', reason: `Multiple project memory entries match remote '${remote}'`, entries: [one, two] });
  });

  it.each([false, true])('unregisters only the selected project with deleteFiles=%s', async deleteFiles => {
    const { registerProjectMemory, removeProjectMemory, lookupProjectMemory,
      projectMemoryManifestPath, projectMemoryIndexPath } = await import('../../../src/memory/project-registry.js');
    const otherWorkspace = path.join(tmp, 'other');
    const selectedRoot = path.join(tmp, 'selected', '.aiwg');
    const otherRoot = path.join(tmp, 'retained', '.aiwg');
    const selected = await registerProjectMemory({ id: 'selected', workspaceRoot: workspace,
      memoryRoot: selectedRoot, gitRemotes: ['git@example.test:org/selected.git'] });
    const retained = await registerProjectMemory({ id: 'retained', workspaceRoot: otherWorkspace,
      memoryRoot: otherRoot, gitRemotes: ['git@example.test:org/retained.git'] });
    const note = path.join(selectedRoot, 'memory/note.md');
    const witness = path.join(otherRoot, 'memory/witness.md');
    await fs.writeFile(note, 'selected owned fixture');
    await fs.writeFile(witness, 'retain owned witness');

    expect(await removeProjectMemory('selected', deleteFiles ? { deleteFiles: true } : undefined)).toEqual(selected);
    expect(JSON.parse(await fs.readFile(projectMemoryManifestPath(), 'utf8'))).toEqual({ version: 1, projects: [retained] });
    const index = JSON.parse(await fs.readFile(projectMemoryIndexPath(), 'utf8'));
    expect(index).toEqual({ version: 1, generatedAt: expect.any(String),
      byProjectId: { retained: 'retained' }, byWorkspaceRoot: { [otherWorkspace]: ['retained'] },
      byGitRemote: { 'example.test/org/retained': ['retained'] } });
    expect(await lookupProjectMemory({ id: 'selected' })).toEqual({ status: 'missing', reason: "No project memory entry with id 'selected'" });
    expect(await lookupProjectMemory({ id: 'retained' })).toEqual({ status: 'found', entry: retained, matchedBy: 'id' });
    if (deleteFiles) await expect(fs.stat(selectedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    else await expect(fs.readFile(note, 'utf8')).resolves.toBe('selected owned fixture');
    await expect(fs.readFile(witness, 'utf8')).resolves.toBe('retain owned witness');

    const manifestBytes = await fs.readFile(projectMemoryManifestPath());
    const indexBytes = await fs.readFile(projectMemoryIndexPath());
    expect(await removeProjectMemory('selected', { deleteFiles: true })).toBeNull();
    expect(await fs.readFile(projectMemoryManifestPath())).toEqual(manifestBytes);
    expect(await fs.readFile(projectMemoryIndexPath())).toEqual(indexBytes);
    if (!deleteFiles) await expect(fs.readFile(note, 'utf8')).resolves.toBe('selected owned fixture');
    await expect(fs.readFile(witness, 'utf8')).resolves.toBe('retain owned witness');
  });

  it('does not create registry files when removing an unknown project', async () => {
    const { removeProjectMemory, projectMemoryManifestPath, projectMemoryIndexPath } = await import('../../../src/memory/project-registry.js');
    expect(await removeProjectMemory('unknown', { deleteFiles: true })).toBeNull();
    await expect(fs.stat(projectMemoryManifestPath())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(projectMemoryIndexPath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(tmp)).toEqual(['workspace']);
  });

  it('relocates memory roots and preserves lookup', async () => {
    const { lookupProjectMemory, registerProjectMemory, relocateProjectMemory, projectMemoryManifestPath } = await import('../../../src/memory/project-registry.js');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-10T11:00:00.000Z'));
      const entry = await registerProjectMemory({ id: 'demo', workspaceRoot: workspace, gitRemotes: [] });
      await fs.writeFile(path.join(entry.memoryRoot, 'memory', 'note.md'), 'private', 'utf-8');
      const config = await fs.readFile(path.join(entry.memoryRoot, 'aiwg.config'));
      vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
      const newRoot = path.join(tmp, 'elsewhere', '.aiwg');
      const expected = { ...entry, memoryRoot: newRoot, updatedAt: '2026-09-10T12:00:00.000Z' };
      expect(await relocateProjectMemory('demo', newRoot)).toEqual(expected);
      await expect(fs.stat(entry.memoryRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(path.join(newRoot, 'memory', 'note.md'), 'utf-8')).resolves.toBe('private');
      expect(await fs.readFile(path.join(newRoot, 'aiwg.config'))).toEqual(config);
      expect(JSON.parse(await fs.readFile(projectMemoryManifestPath(), 'utf8'))).toEqual({ version: 1, projects: [expected] });
      expect(await lookupProjectMemory({ workspaceRoot: workspace })).toEqual({ status: 'found', entry: expected, matchedBy: 'workspaceRoot' });
    } finally { vi.useRealTimers(); }
  });

  it('repairs missing layout at the same location without replacing owned contents', async () => {
    const { registerProjectMemory, relocateProjectMemory, projectMemoryManifestPath } = await import('../../../src/memory/project-registry.js');
    const entry = await registerProjectMemory({ id: 'demo', workspaceRoot: workspace, gitRemotes: [] });
    const artifactDir = path.join(entry.memoryRoot, 'artifacts');
    // Delete only the known empty directory allocated by this test's registration.
    await fs.rmdir(artifactDir);
    await fs.writeFile(path.join(entry.memoryRoot, 'aiwg.config'), '{"owned":"unchanged"}\n');
    await fs.writeFile(path.join(entry.memoryRoot, 'memory/note.md'), 'same root note');
    const relocated = await relocateProjectMemory('demo', entry.memoryRoot);
    expect(relocated).toEqual({ ...entry, updatedAt: expect.any(String) });
    expect((await fs.stat(artifactDir)).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(entry.memoryRoot, 'aiwg.config'), 'utf8')).resolves.toBe('{"owned":"unchanged"}\n');
    await expect(fs.readFile(path.join(entry.memoryRoot, 'memory/note.md'), 'utf8')).resolves.toBe('same root note');
    expect(JSON.parse(await fs.readFile(projectMemoryManifestPath(), 'utf8'))).toEqual({ version: 1, projects: [relocated] });
  });

  it('rejects unknown relocation without creating the destination or registry', async () => {
    const { relocateProjectMemory } = await import('../../../src/memory/project-registry.js');
    await expect(relocateProjectMemory('unknown', path.join(tmp, 'destination'))).rejects.toThrow("No project memory entry with id 'unknown'");
    expect(await fs.readdir(tmp)).toEqual(['workspace']);
  });

  it('returns the default path without creating files for an unregistered workspace', async () => {
    const { resolveProjectMemoryRoot } = await import('../../../src/memory/project-registry.js');
    expect(await resolveProjectMemoryRoot(workspace)).toEqual({ source: 'default',
      root: path.join(workspace, '.aiwg/memory'), reason: 'no registered user-level project memory entry' });
    expect(await fs.readdir(workspace)).toEqual([]);
    expect(await fs.readdir(tmp)).toEqual(['workspace']);
  });

  it('returns the default path for ambiguous workspace mappings without creating it', async () => {
    const { resolveProjectMemoryRoot, registerProjectMemory } = await import('../../../src/memory/project-registry.js');
    await registerProjectMemory({ id: 'one', workspaceRoot: workspace, gitRemotes: [] });
    await registerProjectMemory({ id: 'two', workspaceRoot: workspace, gitRemotes: [] });
    expect(await resolveProjectMemoryRoot(workspace)).toEqual({ source: 'default',
      root: path.join(workspace, '.aiwg/memory'), reason: `Multiple project memory entries match workspace '${workspace}'` });
    expect(await fs.readdir(workspace)).toEqual([]);
  });

  it.each(['unique', 'ambiguous', 'unmatched'])('resolves a local Git remote with %s mapping', async mode => {
    const { resolveProjectMemoryRoot, registerProjectMemory } = await import('../../../src/memory/project-registry.js');
    // Local metadata only: no fetch, push, or contact with the synthetic remote.
    execFileSync('git', ['init', '--quiet', '--template=', workspace]);
    const remote = 'https://example.test/org/fixture.git';
    execFileSync('git', ['-C', workspace, 'remote', 'add', 'origin', remote]);
    const entry = await registerProjectMemory({ id: 'one', workspaceRoot: path.join(tmp, 'registered-elsewhere'),
      gitRemotes: [mode === 'unmatched' ? 'git@example.test:org/other.git' : 'git@example.test:org/fixture.git'] });
    if (mode === 'ambiguous') await registerProjectMemory({ id: 'two', workspaceRoot: path.join(tmp, 'second-elsewhere'),
      gitRemotes: ['git@example.test:org/fixture.git'] });
    const expected = mode === 'unique'
      ? { source: 'user', root: path.join(entry.memoryRoot, 'memory'), entry, reason: 'matched git remote' }
      : { source: 'default', root: path.join(workspace, '.aiwg/memory'), reason: mode === 'ambiguous'
        ? `Multiple project memory entries match remote '${remote}'` : 'no registered user-level project memory entry' };
    expect(await resolveProjectMemoryRoot(workspace)).toEqual(expected);
    expect(await fs.readdir(workspace)).toEqual(['.git']);
    expect(execFileSync('git', ['-C', workspace, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()).toBe(remote);
  });

  it('uses user-level memory for storage only when project-local .aiwg is absent', async () => {
    const { registerProjectMemory, resolveProjectMemoryRoot } = await import('../../../src/memory/project-registry.js');
    const { initStorage, resolveStorage, resetStorage } = await import('../../../src/storage/index.js');
    const entry = await registerProjectMemory({ id: 'demo', workspaceRoot: workspace });

    expect(await resolveProjectMemoryRoot(workspace)).toMatchObject({
      source: 'user',
      root: path.join(entry.memoryRoot, 'memory'),
    });

    await initStorage(workspace);
    const adapter = await resolveStorage('memory');
    await adapter.write('note.md', 'from-user-memory');
    await expect(fs.readFile(path.join(entry.memoryRoot, 'memory', 'note.md'), 'utf-8')).resolves.toBe('from-user-memory');

    resetStorage();
    await fs.mkdir(path.join(workspace, '.aiwg'), { recursive: true });
    expect(await resolveProjectMemoryRoot(workspace)).toMatchObject({
      source: 'project-local',
      root: path.join(workspace, '.aiwg', 'memory'),
    });
  });
});
