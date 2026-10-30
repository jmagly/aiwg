// Shell refusals expose the existing resolver reasons without changing JSON plans.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelsHandler } from '../../../../src/cli/handlers/models.js';
import { shellRefusalDiagnostics } from '../../../../src/cli/handlers/models-refusal.js';
import type { WorkerPolicyDiagnostic } from '../../../../src/models/types.js';
import { resolveWorkerInvocation } from '../../../../src/serve/worker-invocation.js';
import { workerResolutionFixture } from '../../../fixtures/worker-resolution.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const f = workerResolutionFixture();
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-model-refusal-')); roots.push(root);
  const brief = path.join(root, 'brief.md'); await writeFile(brief, 'Synthetic worker task.');
  const request = { role: 'coding', task: 'implementation', group: 'workers', brief,
    workdir: root, final_output: path.join(root, 'final.json'), transport: 'shell' as const };
  const handler = createModelsHandler({
    load: async () => ({ snapshot: f.snapshot, drivers: {} }), now: () => f.request.now,
  });
  const call = async (format: 'json' | 'shell') => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const args = ['resolve', ...Object.entries(request).map(([key, value]) => `--${key.replace('_', '-')}=${value}`),
      `--format=${format}`];
    const result = await handler.execute({ args, rawArgs: ['models', ...args], cwd: root, frameworkRoot: root });
    const stdout = log.mock.calls.map(([value]) => String(value)).join('\n');
    const stderr = err.mock.calls.map(([value]) => String(value)).join('\n');
    log.mockRestore(); err.mockRestore();
    return { result, stdout, stderr };
  };
  return { ...f, now: f.request.now, request, call };
}

describe('#3770 shell refusal reasons', () => {
  it('deduplicates repeated blockers, keeps distinct locations and omits advisory diagnostics without mutation', () => {
    const blocker: WorkerPolicyDiagnostic = { code: 'OG_MODEL_UNAPPROVED', pointer: '/request/authority',
      message: 'Existing premium refusal', roles: ['coding'], blocking: true };
    const other = { ...blocker, pointer: '/parallelism/groups/workers/members/alternate' };
    const advisory = { ...blocker, blocking: false };
    const plan = { diagnostics: [blocker, advisory], exclusions: [
      { group: 'workers', member: 'primary', model: 'synthetic', effort: 'medium', diagnostics: [structuredClone(blocker), other, advisory] },
      { group: 'workers', member: 'primary', model: 'synthetic', effort: 'high', diagnostics: [structuredClone(other)] },
    ] };
    const original = structuredClone(plan);
    const diagnostics = shellRefusalDiagnostics(plan);
    expect(diagnostics).toEqual([blocker, other]);
    expect(diagnostics[0]).toBe(blocker);
    expect(plan).toEqual(original);
  });

  it.each(['premium without authorization', 'unknown task class', 'conflicting role', 'zero host slots'] as const)(
    'preserves the JSON reason for %s on stderr with no stdout command', async kind => {
      const f = await fixture();
      let message: string;
      if (kind === 'premium without authorization') {
        f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.tier = 'premium';
        message = 'premium tier was explicitly requested; Tier 3 requires explicit human confirmation';
      } else if (kind === 'zero host slots') {
        f.snapshot.hostResources = { supported: true, availMemGb: 64, freeDiskGb: 100,
          cores: 8, load1: 0, loadRatio: 0, memPsiAvg10: 0, memPsiAvg60: 0, workers: 1 };
        f.snapshot.config.parallelism!.admission = { hostResources: { max_workers: 1 } };
        message = 'max_workers: 1 running workers >= 1';
      } else {
        f.request.task = kind === 'unknown task class' ? 'unknown-task' : 'architecture';
        message = 'Unknown task class or conflicting role';
      }
      const expected = await resolveWorkerInvocation(f.snapshot, { ...f.request, format: 'json' }, {}, f.now);
      expect(expected.status).toBe('blocked');
      expect(expected.invocation).toBeUndefined();
      if (kind === 'zero host slots') expect(expected.slots).toBe(0);
      const reasons = [...expected.diagnostics, ...expected.exclusions.flatMap(row => row.diagnostics)]
        .filter(reason => reason.blocking !== false);
      expect(reasons.some(reason => reason.message.includes(message))).toBe(true);

      const json = await f.call('json');
      expect(json.result.exitCode).toBe(2);
      expect(json.stderr).toBe('');
      // Full serialized output stays identical, including nested exclusions and metadata.
      expect(json.stdout).toBe(JSON.stringify(expected, null, 2));

      const shell = await f.call('shell');
      expect(shell.result.exitCode).toBe(2);
      expect(shell.stdout).toBe('');
      expect(shell.stderr).toContain(message);
      const refusal = JSON.parse(shell.stderr);
      expect(refusal.status).toBe('blocked');
      expect(refusal.invocation).toBeUndefined();
      for (const reason of reasons) expect(refusal.diagnostics).toContainEqual(reason);
      // Rendering a shell refusal must not mutate the plan subsequently emitted as JSON.
      expect((await f.call('json')).stdout).toBe(json.stdout);
    });
});
