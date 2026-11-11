import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
import { repoAccessHandler } from '../../../../src/cli/handlers/repo-access.js';

describe('repoAccessHandler', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(async () => {
    vi.stubEnv('AIWG_WORKSPACE', '');
    vi.stubEnv('AIWG_ARTIFACTS_PATH', '');
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-repo-access-handler-'));
    projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(path.join(projectDir, '.aiwg', 'ops', 'security'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'handoff'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.aiwg', 'ops', 'security', 'repo-access.manifest.yaml'),
      [
        'version: "1"',
        'repos:',
        '  - name: project',
        '    path: .',
        '    actions: [read, write, commit, push, issue-comment]',
        '  - name: handoff',
        '    path: ../handoff',
        '    actions: [read, issue-comment]',
        '',
      ].join('\n')
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function makeCtx(args: string[]): HandlerContext {
    return {
      args,
      rawArgs: ['repo-access', ...args],
      cwd: projectDir,
      frameworkRoot: projectDir,
    };
  }

  it('has command metadata', () => {
    expect(repoAccessHandler.id).toBe('repo-access');
    expect(repoAccessHandler.category).toBe('utility');
  });

  it('lists manifest entries', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await repoAccessHandler.execute(makeCtx(['list']));

    expect(result.exitCode).toBe(0);
    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('project');
    expect(output).toContain('handoff');
  });

  it('returns zero for allowed checks', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await repoAccessHandler.execute(makeCtx(['check', '--path', '.', '--action', 'write']));

    expect(result.exitCode).toBe(0);
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).toContain('ALLOW write');
  });

  it('returns one for denied checks', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await repoAccessHandler.execute(makeCtx(['check', '--path', '../handoff', '--action', 'write']));

    expect(result.exitCode).toBe(1);
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).toContain('DENY write');
  });

  it.each([false, true])('names canonical config and registration when no manifest exists (config present: %s)', async (configPresent) => {
    await fs.rm(path.join(projectDir, '.aiwg', 'ops'), { recursive: true });
    if (configPresent) {
      await fs.writeFile(
        path.join(projectDir, '.aiwg', 'aiwg.config'),
        JSON.stringify({ version: '1', providers: ['claude'], installed: {}, scripts: {} }),
      );
    }

    const result = await repoAccessHandler.execute(makeCtx([
      'check', '--path', '../handoff', '--action', 'issue-comment',
    ]));

    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('.aiwg/aiwg.config');
    expect(result.message).toContain('workspace');
    expect(result.message).toContain('repos');
    expect(result.message).toContain('aiwg repo-access add');
    expect(result.message).toContain('.aiwg/ops/security/repo-access.manifest.yaml');
    expect(result.message).toContain('.aiwg/security/repo-access.manifest.yaml');
  });

  it.each([false, true])('checks canonical repos permissions (legacy present: %s)', async (legacyPresent) => {
    if (!legacyPresent) {
      await fs.rm(path.join(projectDir, '.aiwg', 'ops'), { recursive: true });
    }
    await fs.writeFile(
      path.join(projectDir, '.aiwg', 'aiwg.config'),
      JSON.stringify({
        workspace: { name: 'canonical', root: '..' },
        repos: [{ name: 'handoff', path: './handoff', allowed: ['read', 'issue-comment'] }],
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const check = (target: string, action: string) => repoAccessHandler.execute(makeCtx([
      'check', '--path', target, '--action', action,
    ]));

    expect((await check('../handoff', 'issue-comment')).exitCode).toBe(0);
    expect((await check('../handoff', 'write')).exitCode).toBe(1);
    // Legacy YAML grants write here; the canonical config leaves it unlisted.
    expect((await check('.', 'write')).exitCode).toBe(1);
    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('ALLOW issue-comment');
    expect(output).toContain('DENY write');
  });

  it('explains unlisted paths without mutating state', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await repoAccessHandler.execute(makeCtx(['explain', '--path', '../other']));

    expect(result.exitCode).toBe(0);
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).toContain('Matched repo: none');
  });

  it('returns usage error for missing action', async () => {
    const result = await repoAccessHandler.execute(makeCtx(['check', '--path', '.']));

    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--action');
  });

  it('shows resolved member policy and drift from the canonical workspace config', async () => {
    await fs.writeFile(
      path.join(projectDir, '.aiwg', 'aiwg.config'),
      JSON.stringify({
        version: '1',
        providers: ['codex'],
        installed: {},
        scripts: {},
        workspace: { name: 'home' },
        repos: [{
          name: 'project',
          path: '.',
          allowed: ['read', 'write'],
        }],
        delivery: { mode: 'direct', default_branch: 'trunk' },
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await repoAccessHandler.execute(makeCtx(['status']));

    expect(result.exitCode).toBe(0);
    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('Source: workspace-config');
    expect(output).toContain('Workspace: home');
    expect(output).toContain('delivery: direct');
    expect(output).toContain('DRIFT:');
  });
});
