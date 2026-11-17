// T-OG-12: configuration wiring must be actionable before dispatch.
import { describe, expect, it } from 'vitest';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { diagnoseWorkerHealthReadiness } from '../../../src/models/worker-health-readiness.js';
import { workerWiringDiagnostics } from '../../../src/models/worker-wiring-diagnostics.js';
import { resolveWorkerPlan } from '../../../src/models/worker-plan.js';

describe('worker policy diagnostics (#4261)', () => {
  it('ignores absent worker declarations and disabled member routes', () => {
    expect(workerWiringDiagnostics(undefined, undefined)).toEqual([]);
    expect(workerWiringDiagnostics({}, undefined)).toEqual([]);
    const { snapshot } = workerResolutionFixture();
    const parallelism = snapshot.config.parallelism!;
    parallelism.groups!.workers.members.forEach(member => { member.enabled = false; });
    expect(workerWiringDiagnostics(parallelism, undefined)).toEqual([]);
    parallelism.groups!.workers.members[0].enabled = true;
    parallelism.clis = { codex: { enabled: false, adapter: 'providers:codex', accountScope: 'local', quotaScope: 'local' } };
    expect(workerWiringDiagnostics(parallelism, undefined)).toEqual([]);
    parallelism.groups!.workers.requiredRoles = ['coding'];
    expect(workerWiringDiagnostics(parallelism, undefined)).toEqual([
      expect.objectContaining({ pointer: '/defaults/workerSelection/roleGuidance/coding/groups' }),
    ]);
  });

  it('checks roles and CLI references inherited from group templates', () => {
    const { snapshot } = workerResolutionFixture();
    const parallelism = snapshot.config.parallelism!;
    parallelism.groupTemplates = { template: parallelism.groups!.workers };
    parallelism.groups = { workers: { template: 'template' } };
    parallelism.clis = { codex: { adapter: 'providers:codex', accountScope: 'local', quotaScope: 'local' } };
    expect(workerWiringDiagnostics(parallelism, snapshot.models.defaults.workerSelection)).toEqual([]);
    snapshot.models.defaults.workerSelection!.roleGuidance!.coding.groups = [];
    expect(workerWiringDiagnostics(parallelism, snapshot.models.defaults.workerSelection)).toHaveLength(1);
  });

  it('reports groups outside guidance with the models.json edit, even when another group resolves', () => {
    const { snapshot, request } = workerResolutionFixture();
    snapshot.config.parallelism!.groups!.cursor = structuredClone(snapshot.config.parallelism!.groups!.workers);
    snapshot.config.parallelism!.groups!.cursor.requiredRoles = ['coding'];
    const report = diagnoseWorkerHealthReadiness(snapshot, request);
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'OG_CONFIG_REFERENCE', pointer: '/defaults/workerSelection/roleGuidance/coding/groups',
      message: expect.stringMatching(/models.json.*cursor/),
    })]));
    const plan = resolveWorkerPlan(snapshot, { ...request, group: 'cursor' });
    expect(plan.status).toBe('blocked');
    expect(plan.diagnostics.some(row => row.message.includes('Run aiwg doctor --probe-workers --qualify'))).toBe(false);
    expect(plan.diagnostics.find(row => row.code === 'OG_CONFIG_REFERENCE')?.message).toContain('models.json');
  });

  it('reports a declared CLI that no group uses', () => {
    const { snapshot, request } = workerResolutionFixture();
    snapshot.config.parallelism!.clis = { cursor: { adapter: 'providers:cursor', accountScope: 'local', quotaScope: 'local' } };
    expect(diagnoseWorkerHealthReadiness(snapshot, request).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'OG_CONFIG_REFERENCE', pointer: '/parallelism/clis/cursor',
        message: expect.stringMatching(/no group.*parallelism.groups/i) }),
    ]));
  });
});
