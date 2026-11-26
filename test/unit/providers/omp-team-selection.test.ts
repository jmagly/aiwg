// Native OMP teams resolve every leaf before starting any fake local client.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as selection from '../../../src/models/delegation.js';
import { runOmpTeam } from '../../../tools/providers/omp-teams.mjs';

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'omp-policy-')); vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); });
const tasks = [{ id: 'read', agent: 'fixture-reader', role: 'efficiency', prompt: 'Read bounded artifacts', tools: ['read'], ownership: [] }];
function clientFactory(_options?: any) {
  return { connect: async () => {}, close: async () => {}, prompt: async (prompt: string) => {
    const agent = JSON.parse(prompt.match(/using agent ("[^"]+")/)![1]);
    return { success: true, text: 'candidate', events: [{ type: 'tool_execution_start', toolName: 'task', args: { agent } },
      { type: 'tool_execution_end', toolName: 'task', result: { details: { results: [{ id: 'read', exitCode: 0 }] } } }] };
  } };
}
describe('T-OG-08 OMP worker tier selection', () => {
  it('asks the shared resolver and pins both native child and coordinator', async () => {
    const resolve = vi.spyOn(selection, 'resolveDelegation');
    const client = vi.fn(clientFactory);
    const result = await runOmpTeam({ cwd, tasks, model: 'fixture/economy', workerTier: 'economy', clientFactory: client });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ orchestrator: 'team', role: 'efficiency', requestedTier: 'economy' }));
    const worker = result.results[0];
    expect(worker).toMatchObject({ status: 'completed', model: 'fixture/economy', routing: { resolved_tier: 'economy', election: null } });
    expect(client.mock.calls[0][0].args).toContain('fixture/economy');
    expect(JSON.parse(await readFile(worker.controlArtifacts.config, 'utf8')).task.agentModelOverrides[worker.nativeAgent]).toBe('fixture/economy');
  });
  it('rejects placeholders before constructing a client', async () => {
    const client = vi.fn(clientFactory);
    await expect(runOmpTeam({ cwd, tasks, clientFactory: client })).rejects.toThrow(/concrete model/);
    expect(client).not.toHaveBeenCalled();
  });
  it('does not infer a flagship election from a model or role pin', async () => {
    const client = vi.fn(clientFactory);
    await expect(runOmpTeam({ cwd, tasks, modelRoles: { efficiency: 'claude-fable-5' }, clientFactory: client })).rejects.toThrow(/Flagship/);
    expect(client).not.toHaveBeenCalled();
    const result = await runOmpTeam({ cwd, tasks, model: 'claude-fable-5', election: 'user', clientFactory: client });
    expect(result.results[0].routing).toMatchObject({ resolved_tier: 'flagship', election: 'user' });
  });
});
