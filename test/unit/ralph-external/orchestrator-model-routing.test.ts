// Exercise model routing before the loop crosses the worker-launch boundary.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../../../tools/ralph-external/orchestrator.mjs';
import { ExternalMultiLoopStateManager } from '../../../tools/ralph-external/external-multi-loop-state-manager.mjs';

let root: string;
let previousCwd: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-orchestrator-model-'));
  previousCwd = process.cwd();
  const home = join(root, 'home');
  await mkdir(join(home, '.config/aiwg'), { recursive: true });
  await writeFile(join(home, '.config/aiwg/models.json'), JSON.stringify({
    claude: { coding: { model: 'synthetic-user-coding' } },
  }));
  await writeFile(join(root, 'models.json'), JSON.stringify({
    claude: { coding: { model: 'synthetic-project-coding' } },
  }));
  vi.stubEnv('HOME', home);
  process.chdir(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  process.chdir(previousCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('T-OG-13 #2644 external loop model routing', () => {
  // #2648: an unpinned loop persists no model; the tier policy resolves one per
  // worker at launch. The configured coding model must never be filled in here.
  it.each([
    { model: undefined, expected: undefined },
    { model: 'synthetic-explicit-model', expected: 'synthetic-explicit-model' },
  ])('registers and persists $expected when model is $model', async ({ model, expected }) => {
    const register = vi.spyOn(ExternalMultiLoopStateManager.prototype, 'createLoop');
    const owner = new Orchestrator(root);
    // Keep real registration and state initialization; no worker CLI is launched.
    const run = vi.spyOn(owner, 'runLoop').mockResolvedValue({ success: true, iterations: 0 });
    await owner.execute({
      objective: 'Synthetic model routing', completionCriteria: 'Selected model is persisted', model,
      enableSnapshots: false, enableCheckpoints: false, crossTask: false,
      enableAnalytics: false, enableBestOutput: false, enableEarlyStopping: false,
      enablePIDControl: false, enableOverseer: false, enableSemanticMemory: false,
      enableClaudeIntelligence: false,
    });

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][0].model).not.toBe('synthetic-project-coding');
    expect(register.mock.calls[0][0].model).toBe(expected);
    expect(owner.registeredLoopId).toBeTruthy();
    expect(owner.stateManager.load().config.model).toBe(expected);
    expect(owner.multiLoopManager.getLoop(owner.registeredLoopId).config.model).toBe(expected);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].config.model).toBe(expected);
  });
});
