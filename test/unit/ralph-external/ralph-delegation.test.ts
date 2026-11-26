// Native Ralph cycles resolve models before the provider launch seam, without model calls.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as selection from '../../../src/models/delegation.js';
import { launchRalphCycle } from '../../../tools/ralph-external/lib/ralph-cycle-launch.mjs';
import { routeRalphWorker } from '../../../tools/ralph-external/lib/ralph-delegation.mjs';
import { classifySessionAttempt } from '../../../tools/ralph-external/lib/session-attempt.mjs';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ralph-tier-')); vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function fixture(model?: string) {
  const adapter = { getName: () => 'claude', hasCapability: () => false, mapModel: (value: string) => value,
    observeHealthEvent: () => undefined, classifySessionAttempt: (input: unknown) => classifySessionAttempt(adapter, input) };
  const launch = vi.fn(async () => ({ exitCode: 0, timedOut: false }));
  const owner = { projectRoot: root, providerAdapter: adapter, stateManager: { save: vi.fn() }, sessionLauncher: { launch } };
  const state = { loopId: 'bounded-worker', objective: 'Implement bounded change', currentIteration: 1,
    config: { model, modelElection: model ? 'user' : undefined, provider: 'claude', enableCheckpoints: false } };
  const options = { prompt: 'bounded assignment', systemPrompt: '', outputPaths: { stdout: join(root, 'stdout'), stderr: join(root, 'stderr') }, iterationDir: root, timeoutMs: 1000 };
  return { owner, state, options, launch };
}
describe('T-OG-08 Ralph native tier resolution', () => {
  it('asks the resolver, launches the resolved model and persists the common record', async () => {
    const f = fixture();
    const resolve = vi.spyOn(selection, 'resolveDelegation');
    await launchRalphCycle(f.owner, f.state, f.options);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ orchestrator: 'ralph', model: undefined }));
    const routing = JSON.parse(await readFile(join(root, 'routing.json'), 'utf8'));
    expect(routing).toMatchObject({ requested_tier: null, resolved_tier: 'standard', election: null });
    expect(f.launch).toHaveBeenCalledWith(expect.objectContaining({ model: routing.resolved_model }));
  });
  it('rechecks project ceiling before each native launch', async () => {
    const f = fixture();
    await writeFile(join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: { maxAutoTier: 'economy' } } }));
    await expect(launchRalphCycle(f.owner, f.state, f.options)).rejects.toThrow(/maxAutoTier/);
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('accepts a flagship only as an explicit user model pin', async () => {
    const f = fixture('claude-fable-5');
    await launchRalphCycle(f.owner, f.state, f.options);
    expect(JSON.parse(await readFile(join(root, 'routing.json'), 'utf8'))).toMatchObject({ election: 'user', resolved_tier: 'flagship' });
  });
  it('does not turn an old saved fallback into a user election on resume', async () => {
    const f = fixture('claude-fable-5');
    f.state.config.modelElection = undefined;
    await expect(launchRalphCycle(f.owner, f.state, f.options)).rejects.toThrow(/Flagship/);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'adapter provider', adapter: { getName: () => 'codex' }, provider: 'codex', model: /^gpt-/ },
    { name: 'missing adapter', adapter: undefined, provider: 'claude', model: /^claude-/ },
    { name: 'unnamed adapter', adapter: { getName: () => undefined }, provider: 'claude', model: /^claude-/ },
  ])('routes legacy state using the $name fallback and persists its identity', async ({ adapter, provider, model }) => {
    const resolve = vi.spyOn(selection, 'resolveDelegation');
    const state = { objective: 'Resume bounded legacy work', config: {} };
    const routing = await routeRalphWorker({ projectRoot: root, providerAdapter: adapter }, state, root);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      workerId: 'ralph-worker', assignment: state.objective, provider,
    }));
    expect(routing).toMatchObject({ orchestrator: 'ralph', workerId: 'ralph-worker', resolved_tier: 'standard', election: null });
    expect(routing.resolved_model).toMatch(model);
    expect(JSON.parse(await readFile(join(root, 'routing.json'), 'utf8'))).toEqual(routing);
  });
});
