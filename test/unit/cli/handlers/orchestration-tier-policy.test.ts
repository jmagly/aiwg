// Verify the public MC and team paths call tier resolution before worker handoff.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as selection from '../../../../src/models/delegation.js';
import { mcRun, estimateMissionRunCost } from '../../../../src/cli/handlers/mc-run.js';
import { teamHandler } from '../../../../src/cli/handlers/team.js';
import { ralphHandler } from '../../../../src/cli/handlers/ralph.js';
import type { Session } from '../../../../src/cli/handlers/mc-types.js';

const mocks = vi.hoisted(() => ({ session: vi.fn(), write: vi.fn(), log: vi.fn(), launch: vi.fn(), submit: vi.fn() }));
vi.mock('../../../../src/cli/handlers/mc-session.js', () => ({ SESSIONS_DIR: '.aiwg/mc', findActiveSession: mocks.session, writeSession: mocks.write, appendLog: mocks.log }));
vi.mock('../../../../src/cli/handlers/ralph-launcher.js', () => ({ launchExternalRalph: mocks.launch }));
vi.mock('../../../../src/cli/handlers/mc-admission.js', () => ({ createMcAdmissionScheduler: async () => ({ submit: mocks.submit }) }));
let root: string;
let session: Session;
const context = (args: string[]) => ({ cwd: root, args, rawArgs: args, frameworkRoot: process.cwd() });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orchestration-policy-'));
  session = { id: 'fixture', name: 'fixture', state: 'active', createdAt: '', updatedAt: '', maxMissions: 4,
    missions: [{ id: 'fixture-worker', objective: 'List the bounded input files', completion: 'inventory exists',
      status: 'queued', loop: 0, maxIterations: 1, priority: 'normal', mode: 'direct', workerTier: 'economy' }] };
  mocks.session.mockResolvedValue(session);
  mocks.launch.mockResolvedValue({ loopId: 'fixture-loop', pid: 12345 });
  mocks.submit.mockReturnValue({ state: 'admitted' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('T-OG-08 MC and team tier handoffs', () => {
  it('MC dry-run resolves explicit tiers without launching or writing a session', async () => {
    const resolve = vi.spyOn(selection, 'resolveDelegation');
    expect((await mcRun(context(['fixture', '--dry-run', '--json']))).exitCode).toBe(0);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ orchestrator: 'mc', requestedTier: 'economy' }));
    const output = vi.mocked(console.log).mock.calls.map(call => String(call[0])).find(line => line.startsWith('{'))!;
    expect(JSON.parse(output).workers[0]).toMatchObject({ tier: 'economy', routing: { requested_tier: 'economy', resolved_tier: 'economy' } });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('MC records the common route and forwards tier intent to Ralph', async () => {
    expect((await mcRun(context(['fixture', '--accept-cost']))).exitCode).toBe(0);
    expect(mocks.launch).toHaveBeenCalledWith(process.cwd(), root, expect.objectContaining({ workerTier: 'economy' }));
    expect(mocks.log).toHaveBeenCalledWith('fixture', expect.objectContaining({ event: 'mission_started', routing: session.missions[0].workerRouting }));
  });

  it('MC refuses flagship before admission and launch', async () => {
    session.missions[0].workerTier = 'flagship';
    expect((await mcRun(context(['fixture', '--accept-cost']))).exitCode).toBe(1);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('tier-aware MC estimates vary and retain observable-spend ceiling rules', () => {
    const estimate = (workerTier: 'economy' | 'standard' | 'premium') => estimateMissionRunCost([{ maxIterations: 2, workerTier }], 'claude').estimateUsd;
    expect(estimate('economy')).toBeLessThan(estimate('standard'));
    expect(estimate('standard')).toBeLessThan(estimate('premium'));
    expect(estimateMissionRunCost([{ maxIterations: 2, workerTier: 'premium', maxTotalCost: 1 }], 'claude').estimateUsd).toBe(1);
    expect(estimateMissionRunCost([{ maxIterations: 2, workerTier: 'premium', maxTotalCost: 1 }], 'codex').estimateUsd).toBe(7.8);
  });
  it('Ralph forwards --worker-tier and refuses a missing tier value', async () => {
    expect((await ralphHandler.execute(context(['bounded task', '--completion', 'trusted checks', '--worker-tier', 'economy']))).exitCode).toBe(0);
    expect(mocks.launch).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ workerTier: 'economy' }));
    mocks.launch.mockClear();
    expect((await ralphHandler.execute(context(['bounded task', '--completion', 'trusted checks', '--worker-tier']))).exitCode).toBe(1);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('native team instructions resolve each worker and print explicit model pins', async () => {
    await mkdir(join(root, '.aiwg/teams'), { recursive: true });
    await writeFile(join(root, '.aiwg/teams/fixture.json'), JSON.stringify({ name: 'fixture', agents: [{ agent: 'fixture-worker', role: 'contributor' }] }));
    const resolve = vi.spyOn(selection, 'resolveDelegation');
    expect((await teamHandler.execute(context(['run', 'fixture', '--provider', 'claude', '--worker-tier', 'economy']))).exitCode).toBe(0);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ orchestrator: 'team', requestedTier: 'economy' }));
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toMatch(/model=\S*haiku/);
  });
});
