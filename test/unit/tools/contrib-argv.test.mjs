import { usePlatformSimulation } from '../../helpers/windows-simulation.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { execFile, editorExecFile } = vi.hoisted(() => ({ execFile: vi.fn(), editorExecFile: vi.fn() }));
vi.mock('../../../src/process/bounded-child-process.mjs', () => ({ boundedExecFileSync: execFile }));
vi.mock('child_process', () => ({ execFileSync: editorExecFile }));
vi.mock('../../../tools/contrib/lib/github-client.mjs', () => ({
  checkGhAuth: () => ({ authenticated: true }),
  getUsername: () => ({ success: true, username: 'tester' }),
  forkRepo: () => ({ success: true, fork: 'owner/repo; echo injected' }),
  createPR: vi.fn(),
  getPRStatus: vi.fn(),
}));
vi.mock('readline', () => ({
  createInterface: () => ({ close: vi.fn(), question: vi.fn() }),
}));

import { addRemotes, createBranch, deployAgents, main } from '../../../tools/contrib/start-contribution.mjs';
import {
  getCommitCount, branchExistsOnRemote, deleteLocalBranch, deleteRemoteBranch,
} from '../../../tools/contrib/abort-contribution.mjs';
import { applyConflictChoice, pushToOrigin } from '../../../tools/contrib/sync-upstream.mjs';
import { isBranchPushed, pushBranch } from '../../../tools/contrib/create-pr.mjs';
import { getGitStatus } from '../../../tools/contrib/status-contribution.mjs';
import { runMarkdownLint, checkManifestSync } from '../../../tools/contrib/lib/quality-validator.mjs';

const simulatePlatform = usePlatformSimulation({ afterEach });

const branch = 'contrib/user/feature; echo injected $(id)';
const remote = 'remote with spaces; echo injected';
const options = (cwd, tier) => expect.objectContaining({ cwd, ...(tier ? { tier } : {}) });

function failure(stderr = 'failed') {
  return Object.assign(new Error('failed'), { stderr, stdout: '' });
}

describe('contribution commands keep data in argv (#142)', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'aiwg-contrib-argv-'));
    execFile.mockReset().mockReturnValue('');
    editorExecFile.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('passes origin and upstream repository URLs as individual arguments', () => {
    const fork = 'owner/repo; echo injected';
    const upstream = 'upstream/repo $(id)';
    expect(addRemotes(fork, upstream, root).success).toBe(true);
    expect(execFile).toHaveBeenCalledWith('git', ['remote', 'add', 'origin', `https://github.com/${fork}.git`], 'quick', options(root));
    expect(execFile).toHaveBeenCalledWith('git', ['remote', 'add', 'upstream', `https://github.com/${upstream}.git`], 'quick', options(root));
    expect(execFile).toHaveBeenCalledWith('git', ['fetch', 'origin'], 'network', options(root, 'network'));
    expect(execFile).toHaveBeenCalledWith('git', ['fetch', 'upstream'], 'network', options(root, 'network'));
  });

  it('verifies and checks out an existing branch without splitting its name', () => {
    expect(createBranch(branch, root).success).toBe(true);
    expect(execFile).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--verify', branch], 'quick', options(root));
    expect(execFile).toHaveBeenNthCalledWith(2, 'git', ['checkout', branch], 'quick', options(root));
  });

  it('creates a missing branch from main, preserving the branch argument', () => {
    execFile.mockImplementationOnce(() => { throw failure(); });
    expect(createBranch(branch, root).success).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith('git', ['checkout', '-b', branch, 'main'], 'quick', options(root));
  });

  it('creates a missing branch from master when main is absent', () => {
    execFile.mockImplementationOnce(() => { throw failure(); });
    execFile.mockImplementationOnce(() => { throw failure(); });
    expect(createBranch(branch, root).success).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith('git', ['checkout', '-b', branch, 'master'], 'quick', options(root));
  });

  it('passes deployment script and target paths as arguments to the bounded launcher', () => {
    const target = path.join(root, 'target with spaces; echo injected');
    expect(deployAgents(target).success).toBe(true);
    const [file, args, tier, opts] = execFile.mock.calls[0];
    expect(file).toBe('node');
    expect(args).toEqual([path.resolve('tools/agents/deploy-agents.mjs'), '--target', target, '--mode', 'sdlc']);
    expect(tier).toBe('long');
    expect(opts.cwd).toBe(target);
  });

  it.each(['clone', 'upstream'])('passes clone arguments and retains %s failure handling', async (failAt) => {
    const cwd = path.join(root, '.local/share/ai-writing-guide');
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', root);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const oldArgv = process.argv;
    process.argv = [process.execPath, 'start-contribution.mjs', 'feature'];
    execFile.mockImplementation((file, args) => {
      if (args[0] === (failAt === 'clone' ? 'clone' : 'remote')) throw failure(`${failAt} failed`);
      return 'configured';
    });
    try {
      await expect(main()).rejects.toThrow('exit');
      expect(execFile).toHaveBeenCalledWith('git', ['clone', 'https://github.com/owner/repo; echo injected.git', cwd], 'long', expect.objectContaining({ tier: 'long' }));
      if (failAt === 'upstream') {
        expect(execFile).toHaveBeenCalledWith('git', ['remote', 'add', 'upstream', 'https://github.com/jmagly/ai-writing-guide.git'], 'quick', options(cwd));
      }
    } finally {
      process.argv = oldArgv;
    }
  });

  it('counts against main and only falls back to master on failure', () => {
    execFile.mockReturnValueOnce(' 7\n');
    expect(getCommitCount(branch, root)).toEqual({ success: true, count: 7 });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith('git', ['rev-list', '--count', branch, '^main'], 'quick', options(root));
    execFile.mockReset().mockImplementationOnce(() => { throw failure(); }).mockReturnValue('3\n');
    expect(getCommitCount(branch, root)).toEqual({ success: true, count: 3 });
    expect(execFile).toHaveBeenLastCalledWith('git', ['rev-list', '--count', branch, '^master'], 'quick', options(root));
  });

  it('returns failed commit count when both bases fail', () => {
    execFile.mockImplementation(() => { throw failure(); });
    expect(getCommitCount(branch, root)).toEqual({ success: false, count: 0 });
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('checks remote branches with separate remote and branch arguments and retains unknown failures', () => {
    execFile.mockReturnValueOnce('hash\trefs/heads/feature\n');
    expect(branchExistsOnRemote(branch, remote, root)).toBe('exists');
    expect(execFile).toHaveBeenLastCalledWith('git', ['ls-remote', '--heads', remote, branch], 'network', options(root, 'network'));
    expect(branchExistsOnRemote(branch, remote, root)).toBe('absent');
    execFile.mockImplementationOnce(() => { throw failure(); });
    expect(branchExistsOnRemote(branch, remote, root)).toBe('unknown');
  });

  it('checks out the selected base and deletes the literal local branch', () => {
    expect(deleteLocalBranch(branch, root).success).toBe(true);
    expect(execFile).toHaveBeenCalledWith('git', ['checkout', 'main'], 'quick', options(root));
    expect(execFile).toHaveBeenCalledWith('git', ['branch', '-D', branch], 'quick', options(root));
  });

  it('deletes a literal remote branch and retains already-deleted handling', () => {
    expect(deleteRemoteBranch(branch, remote, root).success).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith('git', ['push', remote, '--delete', branch], 'network', options(root, 'network'));
    execFile.mockImplementationOnce(() => { throw failure('branch does not exist'); });
    expect(deleteRemoteBranch(branch, remote, root).success).toBe(true);
  });

  it('shows a conflicted filename as one diff argument', () => {
    applyConflictChoice('2', ['file with spaces; echo injected'], 'merge', root);
    expect(execFile).toHaveBeenLastCalledWith('git', ['diff', '--', 'file with spaces; echo injected'], 'quick', options(root));
  });

  it('opens a literal conflicted path while preserving quoted EDITOR arguments', () => {
    vi.stubEnv('EDITOR', '"/editor path/code" --wait --label "merge conflict"');
    const firstFile = 'file with spaces; $(touch injected)';
    applyConflictChoice('1', [firstFile], 'merge', root);
    expect(editorExecFile).toHaveBeenCalledWith('/editor path/code', ['--wait', '--label', 'merge conflict', firstFile], { cwd: root, stdio: 'inherit' });
    expect(existsSync(path.join(root, 'injected'))).toBe(false);
  });

  it.each(['code', 'code.cmd --wait', 'code.bat --wait'])('launches Windows EDITOR=%s with separately quoted operands', editor => {
    const extension = editor.includes('.bat') ? '.bat' : '.cmd';
    const executable = path.join(root, `code${extension}`);
    writeFileSync(executable, '@echo editor launcher');
    simulatePlatform('win32');
    vi.stubEnv('PATH', root);
    vi.stubEnv('PATHEXT', '.CMD;.BAT;.EXE;.COM');
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\custom-cmd.exe');
    vi.stubEnv('EDITOR', editor);
    const firstFile = 'file with spaces & %PATH%.txt';

    applyConflictChoice('1', [firstFile], 'merge', root);

    expect(editorExecFile).toHaveBeenCalledWith(
      process.env.ComSpec,
      ['/d', '/v:off', '/s', '/c', `"${executable} ${editor.includes('--wait') ? '^^^"--wait^^^" ' : ''}^^^"file^^^ with^^^ spaces^^^ ^^^&^^^ ^^^%PATH^^^%.txt^^^""`],
      { cwd: root, stdio: 'inherit', windowsVerbatimArguments: true },
    );
  });

  it.each([
    ['%PATH%', '^^^"^^^%PATH^^^%^^^"'],
    ['100%.txt', '^^^"100^^^%.txt^^^"'],
    ['!x!', '^^^"^^^!x^^^!^^^"'],
    ['&', '^^^"^^^&^^^"'],
    ['^', '^^^"^^^^^^^"'],
    ['"', '^^^"\\^^^"^^^"'],
    ['with spaces', '^^^"with^^^ spaces^^^"'],
    ['', '^^^"^^^"'],
  ])('opens a literal Windows conflict operand %j (#3117)', (firstFile, escaped) => {
    const executable = path.join(root, 'code.cmd');
    writeFileSync(executable, '@echo editor launcher');
    simulatePlatform('win32');
    vi.stubEnv('EDITOR', executable);
    vi.stubEnv('ComSpec', 'cmd.exe');

    applyConflictChoice('1', [firstFile], 'merge', root);

    expect(editorExecFile).toHaveBeenCalledWith(
      'cmd.exe', ['/d', '/v:off', '/s', '/c', `"${executable} ${escaped}"`],
      { cwd: root, stdio: 'inherit', windowsVerbatimArguments: true },
    );
  });

  it('launches a Windows native editor directly, preferring it over a batch launcher', () => {
    const executable = path.join(root, 'notepad.exe');
    writeFileSync(executable, '');
    writeFileSync(path.join(root, 'notepad.cmd'), '@echo editor launcher');
    simulatePlatform('win32');
    vi.stubEnv('PATH', root);
    vi.stubEnv('PATHEXT', '.CMD;.EXE;.COM');
    vi.stubEnv('ComSpec', 'custom-cmd.exe');
    vi.stubEnv('EDITOR', 'notepad');
    const firstFile = 'file with spaces & %PATH%.txt';

    applyConflictChoice('1', [firstFile], 'merge', root);

    expect(editorExecFile).toHaveBeenCalledWith(executable, [firstFile], { cwd: root, stdio: 'inherit' });
  });

  it('resolves a relative Windows editor against the conflict working directory', () => {
    const tools = path.join(root, 'tools');
    mkdirSync(tools);
    const executable = path.join(tools, 'code.cmd');
    writeFileSync(executable, '@echo editor launcher');
    simulatePlatform('win32');
    vi.stubEnv('EDITOR', 'tools\\code --wait');
    vi.stubEnv('PATH', '');
    vi.stubEnv('PATHEXT', '.EXE;.CMD');
    vi.stubEnv('ComSpec', 'custom-cmd.exe');

    applyConflictChoice('1', ['conflict!.txt'], 'merge', root);

    expect(editorExecFile).toHaveBeenCalledWith(
      'custom-cmd.exe',
      ['/d', '/v:off', '/s', '/c', `"${executable} ^^^"--wait^^^" ^^^"conflict^^^!.txt^^^""`],
      { cwd: root, stdio: 'inherit', windowsVerbatimArguments: true },
    );
  });

  it('uses the default editor and reports malformed EDITOR quoting', () => {
    vi.stubEnv('EDITOR', '');
    applyConflictChoice('1', ['conflict.txt'], 'merge', root);
    expect(editorExecFile).toHaveBeenCalledWith('vi', ['conflict.txt'], { cwd: root, stdio: 'inherit' });
    editorExecFile.mockClear();
    vi.stubEnv('EDITOR', '"unfinished');
    applyConflictChoice('1', ['conflict.txt'], 'merge', root);
    expect(editorExecFile).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Failed to open editor'));
  });

  it.each(['rebase', 'merge'])('aborts %s through argv', (strategy) => {
    applyConflictChoice('3', ['conflict.txt'], strategy, root);
    expect(execFile).toHaveBeenLastCalledWith('git', [strategy, '--abort'], 'quick', options(root));
  });

  it.each([false, true])('pushes with force=%s and no empty argument', (force) => {
    expect(pushToOrigin(root, force).success).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith('git', ['push', 'origin', 'HEAD', ...(force ? ['--force-with-lease'] : [])], 'network', options(root, 'network'));
  });

  it('uses literal remote-tracking references and branch arguments during PR preparation', () => {
    expect(isBranchPushed(branch)).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith('git', ['rev-parse', `origin/${branch}`], 'quick', expect.any(Object));
    pushBranch(branch);
    expect(execFile).toHaveBeenLastCalledWith('git', ['push', '-u', 'origin', branch], 'network', expect.any(Object));
    execFile.mockImplementationOnce(() => { throw failure(); });
    expect(isBranchPushed(branch)).toBe(false);
  });

  it('computes contribution status for literal branch names, including missing remotes', () => {
    execFile.mockReturnValueOnce(` ${branch}\n`).mockReturnValueOnce(' M file\n').mockReturnValueOnce('2\t4\n').mockReturnValueOnce('3\t5\n');
    expect(getGitStatus(root)).toEqual({ branch, uncommittedCount: 1, aheadOrigin: 4, behindOrigin: 2, aheadUpstream: 5, behindUpstream: 3 });
    expect(execFile).toHaveBeenCalledWith('git', ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], 'quick', options(root));
    expect(execFile).toHaveBeenCalledWith('git', ['rev-list', '--left-right', '--count', 'upstream/main...HEAD'], 'quick', options(root));
    execFile.mockReset().mockReturnValueOnce(branch).mockReturnValueOnce('').mockImplementation(() => { throw failure(); });
    expect(getGitStatus(root)).toEqual({ branch, uncommittedCount: 0, aheadOrigin: 0, behindOrigin: 0, aheadUpstream: 0, behindUpstream: 0 });
  });

  it('passes the markdown glob literally and retains lint error parsing', () => {
    expect(runMarkdownLint(root).passed).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith('npm', ['exec', 'markdownlint-cli2', '**/*.md'], 'network', options(root, 'network'));
    execFile.mockImplementationOnce(() => { throw failure('README.md:7 MD001 wrong heading'); });
    expect(runMarkdownLint(root)).toEqual({ passed: false, errors: 1, warnings: 0, details: [{ file: 'README.md', line: 7, message: 'MD001 wrong heading' }] });
  });

  it('runs the npm Windows shim through its Node entry point with a literal glob', () => {
    const entry = path.join(root, 'node_modules/npm/bin/npm-cli.js');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, '');
    writeFileSync(path.join(root, 'npm.cmd'), '@ECHO off\n"%_prog%" "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\n');
    vi.stubEnv('PATH', root);
    simulatePlatform('win32');
    expect(runMarkdownLint(root).passed).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith(process.execPath, [entry, 'exec', 'markdownlint-cli2', '**/*.md'], 'network', options(root, 'network'));
  });

  it('passes a manifest-checker path containing spaces and shell characters as one argument', () => {
    const project = path.join(root, 'project with spaces; echo injected');
    const script = path.join(project, 'tools/manifest/check-manifests.mjs');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, '');
    expect(checkManifestSync(project)).toEqual({ synced: true, outOfSync: 0, details: [] });
    expect(execFile).toHaveBeenLastCalledWith('node', [script], 'quick', options(project));
    execFile.mockReturnValueOnce('manifest.json out of sync\n');
    expect(checkManifestSync(project)).toEqual({ synced: false, outOfSync: 1, details: [{ message: 'manifest.json out of sync' }] });
    expect(existsSync(path.join(root, 'injected'))).toBe(false);
  });
});
