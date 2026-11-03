import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { cliToolFiles, isCliPackageFile } from '../../../tools/release/cli-package-files.mjs';
import { Orchestrator } from '../../../tools/ralph-external/orchestrator.mjs';
import { CodexAdapter } from '../../../tools/ralph-external/lib/codex-adapter.mjs';

const roots = [];
const options = {
  objective: 'Complete the synthetic task', completionCriteria: 'Synthetic completion marker',
  provider: 'codex', model: 'synthetic-model', maxIterations: 5,
  enableCheckpoints: false, enableOverseer: false, enableSemanticMemory: false,
  enableClaudeIntelligence: false, enableEarlyStopping: false,
};
function temporary(prefix) { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; }
beforeEach(() => {
  for (const method of ['log', 'warn', 'error']) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fakeCodex(Adapter) {
  const original = Adapter.prototype.buildSessionArgs;
  vi.spyOn(Adapter.prototype, 'getBinary').mockReturnValue(process.execPath);
  vi.spyOn(Adapter.prototype, 'buildSessionArgs').mockImplementation(function (args) {
    return [resolve('test/fixtures/ralph-external/codex-loop.mjs'), ...original.call(this, args)];
  });
}
function offline(owner) {
  vi.spyOn(owner.outputAnalyzer, 'analyzeWithClaude').mockReturnValue(null);
  vi.spyOn(owner.stateAssessor, 'assess').mockResolvedValue({ completionPercentage: 10, phase: 'normal' });
}
function output() { return ['log', 'warn', 'error'].flatMap(method => console[method].mock.calls.flat()).join('\n'); }

describe('external loop dispatch resilience', () => {
  it('runs two Codex workers with the real collector and partial snapshots', async () => {
    fakeCodex(CodexAdapter);
    const root = temporary('codex-loop-');
    mkdirSync(join(root, '.aiwg/.index/project'), { recursive: true });
    if (process.getuid?.() !== 0) {
      mkdirSync(join(root, '.aiwg/working'), { recursive: true });
      const privateFile = join(root, '.aiwg/working/private.json');
      writeFileSync(privateFile, '{}'); chmodSync(privateFile, 0);
    }
    const index = join(root, '.aiwg/.index/project/refresh-state.json');
    writeFileSync(index, '{}'); chmodSync(index, 0);
    const owner = new Orchestrator(root); offline(owner);
    const result = await owner.execute(options);
    expect(result.success, output()).toBe(true);
    expect(result.iterations).toBe(2);
    expect(owner.metricsCollector.history).toHaveLength(1);
    expect(owner.pidController.getDecisionHistory()).toHaveLength(1);
    expect(owner.metricsCollector.history[0].raw.completionPercentage).toBe(0);
    const launches = readFileSync(join(root, '.fake-codex-launches.jsonl'), 'utf8').trim().split('\n');
    expect(launches).toHaveLength(2);
    expect(owner.stateManager.load().iterations[0].preSnapshot.completeness.status).toBe('partial');
    expect(owner.crossTaskLearner.index.tasks).toHaveLength(1);
    expect(owner.crossTaskLearner.index.tasks[0].task_type).toBe('implementation');
    expect(output()).not.toMatch(/computePIDMetrics|recording failed|iteration undefined/);
  });

  it('stops identical initialization failures early without recording or selecting worker output', async () => {
    const root = temporary('init-failure-');
    const owner = new Orchestrator(root); offline(owner);
    const capture = vi.spyOn(owner.snapshotManager, 'capturePreSnapshot').mockImplementation(() => {
      throw Object.assign(new Error('Synthetic snapshot destination unavailable'), { code: 'EACCES' });
    });
    const launch = vi.spyOn(owner.sessionLauncher, 'launch');
    const select = vi.spyOn(owner, 'selectBestOutput');
    const result = await owner.execute({ ...options, maxIterations: 6 });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(launch).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, selectedIteration: null, iterations: 0 });
    expect(result.reason).toMatch(/repeated initialization failure/i);
    const state = owner.stateManager.load();
    expect(state.iterations).toEqual([]);
    expect(state.initializationFailures).toHaveLength(2);
    expect(state.status).toBe('failed');
    const report = readFileSync(join(owner.stateManager.getStateDir(), 'completion-report.md'), 'utf8');
    expect(report).toContain('No worker was launched; no output exists.');
    expect(report).toContain('| Iterations | 0 |');
    expect(report).toContain('| Initialization failures | 2 |');
    expect(output()).not.toMatch(/iteration undefined|Restoring artifacts|selection failed|recording failed/);
  });

  it('recovers from a transient initialization error without creating phantom PID metrics', async () => {
    fakeCodex(CodexAdapter);
    const root = temporary('transient-init-');
    const owner = new Orchestrator(root); offline(owner);
    vi.spyOn(owner.snapshotManager, 'capturePreSnapshot').mockImplementationOnce(() => {
      throw Object.assign(new Error('Synthetic transient failure'), { code: 'EIO' });
    });
    const result = await owner.execute(options);
    expect(result.success, output()).toBe(true);
    expect(owner.stateManager.load().iterations).toHaveLength(2);
    expect(owner.stateManager.load().initializationFailures).toHaveLength(1);
    expect(owner.metricsCollector.history).toHaveLength(1);
    expect(owner.pidController.getDecisionHistory()).toHaveLength(1);
  });

  it('rejects empty analytics selections even when a worker iteration exists', () => {
    const owner = new Orchestrator(temporary('empty-selection-'));
    const state = owner.stateManager.initialize(options);
    owner.initializeModules(state, 'codex');
    state.currentIteration = 1;
    state.iterations = [{ number: 1, status: 'completed' }];
    return expect(owner.selectBestOutput(state)).resolves.toMatchObject({ bestIteration: 1 });
  });

  it('handles an already exhausted zero-iteration run without undefined selection', async () => {
    const root = temporary('zero-iterations-');
    const owner = new Orchestrator(root);
    const state = owner.stateManager.initialize({ ...options, maxIterations: 1 });
    state.currentIteration = 1;
    owner.initializeModules(state, 'codex');
    const result = await owner.runLoop(state);
    expect(result.selectedIteration).toBeNull();
    expect(output()).toContain('No worker output was recorded');
    expect(output()).not.toMatch(/iteration undefined|Restoring artifacts|selection failed|recording failed/);
  });

  it('launches packaged Codex loop workers using only manifest-shipped tools and dist', { timeout: 60000 }, async () => {
    const source = process.cwd();
    const packed = temporary('packed-ralph-');
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    expect(manifest.files).toContain('dist/src/');
    writeFileSync(join(packed, 'package.json'), JSON.stringify(manifest));
    for (const file of cliToolFiles(source, manifest.files)) {
      mkdirSync(dirname(join(packed, file)), { recursive: true });
      copyFileSync(join(source, file), join(packed, file));
    }
    cpSync(join(source, 'dist/src'), join(packed, 'dist/src'), { recursive: true,
      filter: path => path === join(source, 'dist/src') || isCliPackageFile(relative(source, path), manifest.files) });
    const capabilities = 'agentic/code/providers/model-capabilities.v1.json';
    expect(manifest.files).toContain('agentic/');
    mkdirSync(dirname(join(packed, capabilities)), { recursive: true });
    copyFileSync(join(source, capabilities), join(packed, capabilities));
    symlinkSync(join(source, 'node_modules'), join(packed, 'node_modules'), 'dir');
    expect(existsSync(join(packed, 'src'))).toBe(false);
    const root = temporary('packed-workspace-');
    const captured = execFileSync(process.execPath, [resolve('test/fixtures/ralph-external/packed-loop.mjs'), packed, root], {
      encoding: 'utf8', timeout: 20000,
      env: { PATH: process.env.PATH, HOME: root, AIWG_RESOLVE_IMPL_FROM: 'dist' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const summary = JSON.parse(captured.split('\n').find(line => line.startsWith('PACKED_RESULT ')).slice(14));
    expect(summary.result).toMatchObject({ success: true, iterations: 2 });
    expect(summary.metrics).toHaveLength(1);
    expect(summary.decisions).toBe(1);
    expect(summary.launches).toBe(2);
    expect(captured).not.toMatch(/computePIDMetrics|recording failed|iteration undefined/);
  });
});
