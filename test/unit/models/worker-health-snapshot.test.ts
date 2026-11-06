// Verify historical health projection with synthetic, already-inspected approval inputs.
import { describe, expect, it, vi } from 'vitest';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { recordedWorkerHealthSnapshot } from '../../../src/models/worker-health-snapshot.js';
import { inspectRecordedWorkerQualifications } from '../../../src/models/worker-installation.mjs';

vi.mock('../../../src/models/worker-installation.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/models/worker-installation.mjs')>(),
  inspectRecordedWorkerQualifications: vi.fn(),
}));

describe('offline recorded worker health snapshot', () => {
  it('projects only inspected historical inputs without mutating the supplied snapshot', async () => {
    const { snapshot } = workerResolutionFixture();
    const before = structuredClone(snapshot);
    const binding = structuredClone(snapshot.installations.codex);
    const adapter = structuredClone(snapshot.registry.providers.codex.workerAdapter!);
    const observations = structuredClone(snapshot.catalog.discovery!.instances!.codex);
    snapshot.installations = {};
    snapshot.catalog.discovery!.instances = {};
    vi.mocked(inspectRecordedWorkerQualifications).mockResolvedValue([{ cli: 'codex', provider: 'codex', binding, adapter, observations }]);
    const result = await recordedWorkerHealthSnapshot(snapshot, '/synthetic/project');
    expect(result.installations).toEqual(before.installations);
    expect(result.catalog.discovery!.instances!.codex).toEqual(observations);
    expect(snapshot.installations).toEqual({});
    expect(snapshot.catalog.discovery!.instances).toEqual({});
    expect(inspectRecordedWorkerQualifications).toHaveBeenCalledWith({ cwd: '/synthetic/project',
      policy: snapshot.models.defaults.workerSelection, parallelism: snapshot.config.parallelism, includeInputs: true });
  });

  it.each(['missing', 'rejected'] as const)('retains missing installation errors for %s approvals', async state => {
    const { snapshot } = workerResolutionFixture();
    snapshot.installations = {};
    if (state === 'missing') vi.mocked(inspectRecordedWorkerQualifications).mockResolvedValue([]);
    else vi.mocked(inspectRecordedWorkerQualifications).mockRejectedValue(new Error('untrusted store'));
    const result = await recordedWorkerHealthSnapshot(snapshot, '/synthetic/project');
    expect(result).toEqual(snapshot);
  });

  it('does not synthesize bindings or model evidence for incomplete historical records', async () => {
    const { snapshot } = workerResolutionFixture();
    snapshot.installations = {};
    vi.mocked(inspectRecordedWorkerQualifications).mockResolvedValue([{ cli: 'codex', provider: 'codex' }]);
    expect(await recordedWorkerHealthSnapshot(snapshot, '/synthetic/project')).toEqual(snapshot);
  });
});
