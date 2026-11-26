// Cross-component default agreement uses temporary model policy and no worker processes.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { routeModelTier, resolveModelTier } from '../../../src/models/router.js';
import { resolveDelegation } from '../../../src/models/delegation.js';
import { mcRun, estimateMissionRunCost, TIER_CACHE_USD } from '../../../src/cli/handlers/mc-run.js';
import { routeRalphWorker } from '../../../tools/ralph-external/lib/ralph-delegation.mjs';
import { handleStewardModels } from '../../../src/cli/handlers/steward-models.js';
import type { Session } from '../../../src/cli/handlers/mc-types.js';

const mocks = vi.hoisted(() => ({ session: vi.fn(), write: vi.fn() }));
vi.mock('../../../src/cli/handlers/mc-session.js', () => ({
  SESSIONS_DIR: '.aiwg/mc', findActiveSession: mocks.session, writeSession: mocks.write,
}));
let root: string;
let session: Session;
const guidance = { groups: ['workers'], tier: 'economy', initialEffort: 'low', effortLadder: ['low'] };
const put = (file: string, workerSelection: object) => writeFile(join(root, file), JSON.stringify({ defaults: { workerSelection } }));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'router-policy-'));
  await mkdir(join(root, 'user'));
  vi.stubEnv('AIWG_CONFIG', join(root, 'user'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  session = { id: 'fixture', name: 'fixture', state: 'active', createdAt: '', updatedAt: '', maxMissions: 1,
    missions: [{ id: 'bounded-worker', objective: 'Implement a bounded change', completion: 'checks pass',
      status: 'queued', loop: 0, maxIterations: 2, priority: 'normal', mode: 'direct' }] };
  mocks.session.mockResolvedValue(session);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('T-OG-01 #2644 router, Ralph and MC default agreement', () => {
  it.each(['builtin', 'cost-effective', 'balanced', 'quality'])('resolves the same %s policy at each entry point', async strategy => {
    if (strategy !== 'builtin') {
      await put('user/models.json', { strategy: 'balanced', maxAutoTier: 'standard' });
      await put('models.json', { strategy, maxAutoTier: 'economy', roleGuidance: { coding: guidance } });
    }
    const models = await new ConfigLoader(root).load();
    const router = await resolveModelTier({ agentName: 'bounded-worker' }, root);
    const ralph = await routeRalphWorker({ projectRoot: root }, {
      loopId: 'bounded-worker', objective: session.missions[0].objective, config: { provider: 'claude' },
    }, root);
    expect((await mcRun({ args: ['fixture', '--dry-run', '--json'], rawArgs: [], cwd: root,
      frameworkRoot: process.cwd() })).exitCode).toBe(0);
    const mc = session.missions[0].workerRouting!;
    expect(router.modelTier).toBe(mc.resolved_tier);
    expect(ralph).toEqual({ ...mc, orchestrator: 'ralph' });
    expect(router.requiresConfirmation).toBe(false);
    expect(router.rationale.join('; ')).toContain(mc.strategy);
    expect(router.rationale.join('; ')).toContain(`automatic ceiling ${mc.max_auto_tier}`);
    expect(mc.resolved_tier).toBe(strategy === 'builtin' ? 'standard' : 'economy');
    expect(mc.strategy).toBe(strategy === 'builtin' ? 'cost-effective' : strategy);
    expect(routeModelTier({}, models)).toEqual(router);
    // The resolved tier controls the dollar floor; its Sonnet label cannot select a model.
    expect(estimateMissionRunCost(session.missions, 'claude').estimateUsd).toBe(2 * TIER_CACHE_USD[mc.resolved_tier]);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('inherits user guidance and strategy when the project only narrows its ceiling', async () => {
    await put('user/models.json', { strategy: 'quality', maxAutoTier: 'standard', roleGuidance: { coding: guidance } });
    await put('models.json', { maxAutoTier: 'economy' });
    expect(await resolveModelTier({}, root)).toMatchObject({ modelTier: 'economy', requiresConfirmation: false });
    await put('models.json', { maxAutoTier: 'premium' });
    await expect(resolveModelTier({}, root)).rejects.toThrow(/OG_POLICY_RELAXATION/);
  });

  it('loads project policy at the public steward model-advice entry point', async () => {
    await put('models.json', { strategy: 'balanced', maxAutoTier: 'economy', roleGuidance: { coding: guidance } });
    const args = ['models', '--json'];
    await handleStewardModels(args, {} as never, { args, rawArgs: args, cwd: root, frameworkRoot: process.cwd() });
    const output = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));
    expect(output.decision).toMatchObject({ modelTier: 'economy', requiresConfirmation: false });
    expect(output.decision.rationale.join('; ')).toContain('balanced');
  });

  it('uses task classes and role guidance without lowering a routine task below its floor', async () => {
    await put('models.json', { strategy: 'balanced', maxAutoTier: 'standard',
      taskClasses: { inspect: 'reviewer' }, roleGuidance: {
        coding: { ...guidance, tier: 'standard' }, reviewer: { ...guidance, baseRole: 'coding', tier: 'standard' },
      } });
    const request = { task: 'inspect', routine: true };
    const decision = await resolveModelTier(request, root);
    expect(decision).toMatchObject({ modelTier: 'standard', requiresConfirmation: false });
    const delegated = await resolveDelegation({ ...request, orchestrator: 'mc', workerId: 'inspect-worker',
      assignment: 'Inspect bounded inputs', provider: 'claude', cwd: root });
    expect(delegated.record.resolved_tier).toBe(decision.modelTier);
    await expect(resolveModelTier({ task: 'missing' }, root)).rejects.toThrow(/Unknown worker task/);
  });

  it('uses the policy ceiling unattended and still requires authority above it', async () => {
    await put('models.json', { maxAutoTier: 'economy' });
    expect(await resolveModelTier({ unattended: true }, root)).toMatchObject({ modelTier: 'standard', requiresConfirmation: true });
    expect(await resolveModelTier({ unattended: true, maxAutoTier: 2 }, root)).toMatchObject({ requiresConfirmation: false });
    expect(routeModelTier({ unattended: true, complex: true })).toMatchObject({ modelTier: 'standard', requiresConfirmation: false });
    expect(routeModelTier({ defaultTier: -1 as never, maxAutoTier: -1 as never })).toMatchObject({ modelTier: 'standard', requiresConfirmation: false });
    expect(routeModelTier({ requestedTier: 'premium' })).toMatchObject({ modelTier: 'premium',
      requiresConfirmation: true, summaryRequired: true });
  });

  it('retains the removal of hardcoded opus fallbacks in the Ralph orchestrator', async () => {
    const source = await readFile(new URL('../../../tools/ralph-external/orchestrator.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bopus\b/i);
  });
});
