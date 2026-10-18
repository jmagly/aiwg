import { useFixtureProcesses } from '../../helpers/fixture-processes.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { SnapshotManager } from '../../../tools/ralph-external/snapshot-manager.mjs';
import { GiteaTracker } from '../../../tools/ralph-external/gitea-tracker.mjs';
import { EvalHarness } from '../../../tools/ralph-external/eval-harness.mjs';
import { MultiLoopStateManager } from '../../../tools/ralph/state-manager-sync.mjs';
import { ProviderWatcher } from '../../../tools/daemon/provider-watcher.mjs';

const trackFixture = useFixtureProcesses();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
let root;
let log;
const payload = 'space "quote"; $(touch injected)';

function calls() {
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function runTool(relative, args) {
  return execFileSync(process.execPath, [join(repoRoot, relative), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, AIWG_RESOLVE_IMPL_FROM: 'src' },
    timeout: 60_000,
  });
}

describe('remaining CodeQL shell callers in tools', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-residual-tools-'));
    log = join(root, 'calls.jsonl');
    writeFileSync(log, '');
    for (const tool of ['git', 'curl', 'tmux', 'instrument', 'npm']) {
      const binary = join(root, tool);
      copyFileSync(join(repoRoot, 'test/fixtures/codeql-residual/fake-tool.mjs'), binary);
      chmodSync(binary, 0o755);
    }
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
    vi.stubEnv('AIWG_FAKE_TOOL_LOG', log);
    vi.stubEnv('AIWG_FAKE_TOOL_FILE', payload);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('passes snapshot revision ranges and changed file paths as literal git arguments', () => {
    const manager = new SnapshotManager(root);
    const diffs = manager.calculateFileDiffs(root, payload, 'end revision');
    expect(diffs).toEqual([{ path: payload, status: 'modified', diff: 'literal diff\n' }]);
    expect(manager.getCommitsSince(root, payload)).toEqual(['abc123 ralph: fixture']);
    expect(calls().map(call => call.args)).toEqual([
      ['diff', '--name-status', '--end-of-options', `${payload}..end revision`],
      ['diff', '--end-of-options', `${payload}..end revision`, '--', payload],
      ['log', '--pretty=format:%H %s', '--end-of-options', `${payload}..HEAD`],
    ]);
    expect(existsSync(join(root, 'injected'))).toBe(false);
  });

  it('keeps Gitea payloads and URLs literal and passes the token through stdin', () => {
    const tokenPath = join(root, `token ${payload}`);
    writeFileSync(tokenPath, 'secret-token\n');
    const tracker = new GiteaTracker({ owner: 'owner', repo: 'repo', tokenPath });
    const data = { body: payload + " ' apostrophe" };
    expect(tracker.apiCall('POST', `/repos/${payload}`, data)).toEqual({ number: 42 });
    expect(calls()).toEqual([{
      tool: 'curl',
      args: ['-s', '-X', 'POST', '-H', '@-', '-H', 'Content-Type: application/json',
        `https://git.integrolabs.net/api/v1/repos/${payload}`, '-d', JSON.stringify(data)],
      input: 'Authorization: token secret-token\n',
    }]);
    expect(existsSync(join(root, 'injected'))).toBe(false);
    vi.stubEnv('AIWG_FAKE_TOOL_FAIL', 'curl');
    expect(() => tracker.apiCall('GET', '/repos/owner/repo')).toThrow('Gitea API call failed:');
  });

  it('preserves explicitly configured eval harness shell pipelines and exit codes', () => {
    const harness = new EvalHarness({ score: { command: 'instrument "literal argument" | cat' } }, { workingDir: root });
    expect(harness.run().status).toBe('pass');
    expect(calls()[0].args).toEqual(['literal argument']);
    const failing = new EvalHarness({ lint: { command: 'instrument; exit 7' } }, { workingDir: root });
    expect(failing.run().status).toBe('void');
  });

  it('starts, queries and stops daemon tmux sessions with literal platform arguments', () => {
    const output = runTool('tools/daemon/index.mjs', ['pty', 'start', 'codex', '--tmux', '--', payload, '']);
    expect(output).toContain('PTY session started in tmux:');
    const start = calls()[0].args;
    expect(start.slice(0, 3)).toEqual(['new-session', '-d', '-s']);
    expect(start.slice(4)).toEqual(['-x', '80', '-y', '24', '--', 'env', '--', 'codex', payload, '']);
    const sessionId = start[3].replace('aiwg-pty-', '');
    expect(calls()[1].args).toEqual(['list-panes', '-t', start[3], '-F', '#{pane_pid}']);
    const sessionPath = join(root, '.aiwg/daemon/pty', `${sessionId}.json`);
    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    const pane = trackFixture(spawn(process.execPath, [join(repoRoot, 'test/fixtures/process/ignore-sigterm.mjs')], { stdio: 'ignore' }));
    session.pid = pane.pid;
    session.tmuxSession = payload;
    writeFileSync(sessionPath, JSON.stringify(session));
    expect(runTool('tools/daemon/index.mjs', ['pty', 'stop', sessionId])).toContain('stopped');
    expect(calls()[2].args).toEqual(['kill-session', '-t', payload]);
    expect(existsSync(join(root, 'injected'))).toBe(false);
  });

  it('uses direct tmux execution when a custom platform has no extra arguments', () => {
    expect(runTool('tools/daemon/index.mjs', ['pty', 'start', payload, '--tmux'])).toContain('PTY session started in tmux:');
    expect(calls()[0].args.slice(8)).toEqual(['--', 'env', '--', payload]);
    expect(existsSync(join(root, 'injected'))).toBe(false);
  });

  it('escapes tmux command separators in custom platform names and trailing arguments', () => {
    expect(runTool('tools/daemon/index.mjs', ['pty', 'start', 'platform;', '--tmux', '--', ';', 'value;', 'value;;', '\\;']))
      .toContain('PTY session started in tmux:');
    expect(calls()[0].args.slice(8)).toEqual(['--', 'env', '--', 'platform\\;', '\\;', 'value\\;', 'value;\\;', '\\\\;']);
  });

  it.each(['linux', 'win32'])('keeps npm watcher package names literal on %s', async platform => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const watcher = new ProviderWatcher({ stateDir: join(root, 'watcher') });
    const state = { lastSeenVersions: {} };
    if (platform === 'win32') {
      writeFileSync(join(root, 'npm.cmd'), '@ECHO off\n"%_prog%" "%dp0%\\npm" %*\n');
      vi.stubEnv('PATH', root);
    }
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      expect(await watcher.checkNpm('fixture', { url: payload }, state)).toEqual(expect.objectContaining({ newVersion: '1.2.3' }));
      expect(calls()).toEqual([{ tool: 'npm', args: ['view', payload, 'version', 'dist-tags', '--json'], input: '' }]);
      expect(state.lastSeenVersions[`npm:${payload}`]).toBe('1.2.3');
      expect(existsSync(join(root, 'injected'))).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('passes the Ralph abort loop pattern as one git argument', () => {
    const manager = new MultiLoopStateManager(root);
    const { loopId } = manager.createLoop({ loopId: payload, task: 'Fixture task', completion: 'done', maxIterations: 1 });
    expect(runTool('tools/ralph/ralph-abort.mjs', ['--loop-id', loopId, '--revert'])).toContain('Found 1 ralph commits');
    expect(calls()[0].args).toEqual(['log', '--oneline', `--grep=^ralph:.*${loopId}`, '-n', '20']);
  });
});
