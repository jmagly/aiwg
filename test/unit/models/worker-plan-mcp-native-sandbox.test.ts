// MCP transport on a native-sandbox group names the route that works, including from a confined conductor (#4147).
import { expect, it } from 'vitest';
import { WORKER_OPERATOR_APPROVAL } from '../../../src/models/provider-policy.js';
import { resolveWorkerPlan } from '../../../src/models/worker-plan.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

it('#4147 explains that --transport mcp means an MCP-server worker and names the shell route for native-sandbox groups', () => {
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism!.groups!.workers.execution = {
    launchMode: 'native-sandbox', transport: 'shell', sandbox: 'workspace-write', approval: 'never', network: 'deny',
  };
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  adapter.provider = 'codex'; adapter.qualification.evidenceRef = WORKER_OPERATOR_APPROVAL;
  const plan = resolveWorkerPlan(f.snapshot, { ...f.request, group: 'workers', transport: 'mcp' });
  expect(plan.status).toBe('blocked');
  const diagnostic = plan.diagnostics.find(d => d.code === 'OG_POLICY_RELAXATION');
  expect(diagnostic?.pointer).toBe('/parallelism/groups/workers/execution/launchMode');
  expect(diagnostic?.message).toContain('--transport mcp selects an MCP-server worker');
  expect(diagnostic?.message).toContain('--transport shell');
  expect(diagnostic?.message).toContain('worker-invoke transport "shell"');
  expect(diagnostic?.message).not.toMatch(/does not support native-sandbox isolation\. Use models resolve --transport shell and the shell launcher/);
  expect(plan.exclusions.every(e => e.diagnostics.some(d => d.code === 'OG_POLICY_RELAXATION'))).toBe(true);
  expect(resolveWorkerPlan(f.snapshot, { ...f.request, group: 'workers', transport: 'shell' }).status).toBe('eligible');
});
