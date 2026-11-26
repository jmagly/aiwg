// Exercise real conductor handoffs with a spy on the common model resolver.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as selection from '../../../src/models/delegation.js';
import { MissionConductor } from '../../../src/serve/mission-conductor.js';
import { FleetMissionConductor } from '../../../src/serve/fleet-mission-conductor.js';

afterEach(() => vi.restoreAllMocks());
const executor = { executorId: 'synthetic-executor', name: 'fixture', connected: true,
  capabilities: ['runtime:codex'], currentMissions: new Set(), transportEndpoints: {}, registeredAt: '2026-11-24T00:00:00Z' } as any;
const plan = { missionId: 'synthetic', goal: 'bounded work', completionCriterion: 'trusted checks pass',
  cycles: [{ id: 'implementation', runtime: 'codex', prompt: 'Implement bounded change', workerTier: 'standard' as const }] };

describe('T-OG-08 conductor tier handoffs', () => {
  it.each(['mission', 'fleet'] as const)('%s asks the resolver and forwards an explicit model and record', async kind => {
    const resolve = vi.spyOn(selection, 'resolveDelegation');
    const runWorker = vi.fn((_cycle: any, _executor: any, _invocation: any) => ({ output: 'candidate', events: [{ revision: 1, observedState: 'succeeded', lastSeen: '2026-11-24T00:00:00Z' }] }));
    const ledger = kind === 'mission' ? await new MissionConductor({ runWorker }).conduct(plan, [executor])
      : await new FleetMissionConductor({ runWorker }).conduct({ ...plan, orchestratorId: 'root', aggregation: { mode: 'all-pass' }, cycles: [{ ...plan.cycles[0], workloadKind: 'one-shot-command' }] } as any, [executor]);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'implementation', requestedTier: 'standard' }));
    expect(runWorker).toHaveBeenCalledOnce();
    const invocation = runWorker.mock.calls[0][2];
    expect(invocation.model).toBe(invocation.routing.resolved_model);
    expect(ledger.activityLog).toContain(JSON.stringify(invocation.routing));
  });

  it.each(['implementation', 'flow:delivery'])('blocks %s execution when the resolver refuses flagship', async id => {
    const runWorker = vi.fn();
    const ledger = await new MissionConductor({ runWorker }).conduct({ ...plan,
      cycles: [{ ...plan.cycles[0], id, workerTier: 'flagship' }] }, [executor]);
    expect(runWorker).not.toHaveBeenCalled();
    expect(ledger.checkpoint.failed).toEqual([id]);
  });

  it('routes a flow cycle through default tier policy and records flow ownership', async () => {
    const resolve = vi.spyOn(selection, 'resolveDelegation');
    const runWorker = vi.fn((_cycle: any, _executor: any, _invocation: any) => ({ output: 'candidate', events: [{ revision: 1, observedState: 'succeeded', lastSeen: '2026-11-24T00:00:00Z' }] }));
    const ledger = await new MissionConductor({ runWorker }).conduct({ ...plan,
      cycles: [{ id: 'flow:delivery', runtime: 'codex', prompt: 'Implement bounded change' }] }, [executor]);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ orchestrator: 'flow', workerId: 'flow:delivery', requestedTier: undefined }));
    expect(runWorker).toHaveBeenCalledOnce();
    const invocation = runWorker.mock.calls[0][2];
    expect(invocation.routing).toMatchObject({ orchestrator: 'flow', requested_tier: null, resolved_tier: 'standard', election: null });
    expect(invocation.model).toBe(invocation.routing.resolved_model);
    expect(ledger.activityLog).toContain(JSON.stringify(invocation.routing));
  });
});
