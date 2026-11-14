// A missing brief is named as such when the selected adapter needs brief content (#4161).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup(buildInvocation: (input: any) => Promise<any>) {
  const f = workerResolutionFixture();
  const root = await mkdtemp(join(tmpdir(), 'aiwg-brief-missing-')); roots.push(root);
  const cwd = join(root, 'work'); await mkdir(cwd);
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  const boundary = { kind: 'os' as const, identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] };
  f.snapshot.installations.codex.boundary = boundary;
  const drivers = { codex: { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0', boundary }, buildInvocation, extractFinal: () => null } };
  const request = { role: 'coding', task: 'implementation', group: 'workers', brief: join(root, 'brief.md'), workdir: cwd, final_output: join(root, 'final.json') };
  return { f, drivers, request };
}

const needsBrief = async (input: any) => {
  if (!input.brief) throw new Error('driver requires brief content');
  return { argv: ['/synthetic/worker'], stdin: 'closed', envNames: [] };
};

it('reports brief_missing at /request/brief, not an adapter failure', async () => {
  const { f, drivers, request } = await setup(needsBrief);
  const plan = await resolveWorkerInvocation(f.snapshot, request as any, drivers as any, f.request.now);
  expect(plan.invocation).toBeUndefined();
  expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_CONFIG_REFERENCE', reason: 'brief_missing', pointer: '/request/brief' }));
  expect(plan.diagnostics.some(d => d.code === 'OG_ADAPTER_UNQUALIFIED')).toBe(false);
});

it('keeps a failing driver with a present brief an adapter build failure', async () => {
  const { f, drivers, request } = await setup(async () => { throw new Error('broken driver'); });
  await writeFile(request.brief, 'synthetic task');
  const plan = await resolveWorkerInvocation(f.snapshot, request as any, drivers as any, f.request.now);
  expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED', reason: 'invocation_build_failed' }));
});

it('still returns a preparatory plan when the adapter builds without a brief', async () => {
  const { f, drivers, request } = await setup(async () => ({ argv: ['/synthetic/worker'], stdin: 'closed', envNames: [] }));
  const plan = await resolveWorkerInvocation(f.snapshot, request as any, drivers as any, f.request.now);
  expect(plan.invocation).toMatchObject({ readiness: 'preparatory', briefDigest: null });
});
