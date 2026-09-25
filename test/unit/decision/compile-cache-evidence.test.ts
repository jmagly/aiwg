import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateCacheBenchmarkTarget, verifyQualificationArtifacts,
  type QualificationEvidenceManifest, type QualificationRunManifest,
} from '../../../src/decision/index.js';

const root = 'docs/decision/evidence/compile-cache-ccp-v1';
const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

describe('D30 retained CCP qualification evidence', () => {
  const run = json<QualificationRunManifest>(`${root}/d30-ccp-offline-v1/run-manifest.json`);
  const manifest = json<QualificationEvidenceManifest>(`${root}/d30-ccp-offline-v1/evidence-manifest.json`);

  it('CCP-D11 is an offline run at an exact clean commit with verified artifacts for G0, G1, G2 and G5', async () => {
    expect(run).toMatchObject({ schemaVersion: 'decision-qualification-run/v1', mode: 'offline', dirty: false });
    expect(run.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.sourceCommit).toBe(run.sourceCommit);
    expect(run.evidence.map(item => item.caseId)).toEqual(['D30-CCP-G0', 'D30-CCP-G1', 'D30-CCP-G2', 'D30-CCP-G5']);
    expect(await verifyQualificationArtifacts(run, root)).toEqual(run.evidence.map(item => ({ caseId: item.caseId, verified: true })));
    expect(manifest.evidence.map(item => [item.caseId, item.artifact.digest]))
      .toEqual(run.evidence.map(item => [item.caseId, item.digest]));
    for (const item of run.evidence) {
      const artifact = json<{ details: { gate: string; tests: Array<{ id: string; status: string }> } }>(`${root}/${item.artifact}`);
      expect(artifact.details.gate).toBe(item.caseId.slice(-2));
      expect(artifact.details.tests.length).toBeGreaterThan(0);
    }
    // Every retained evidence ID still names a test in the current CCP suites.
    const titles = ['compile-cache.test.ts', 'compile-cache-closure.test.ts']
      .map(name => readFileSync(`test/unit/decision/${name}`, 'utf8')).join('\n');
    for (const id of run.evidence.flatMap(item => item.testEvidenceIds ?? [])) expect(titles).toContain(`it('${id} `);
  });

  it('CCP-011 retains the preregistered plan and enforces its minimum benefit target', () => {
    const plan = json<{ minimumBenefitTargetBps: number; warmupCalls: number; measuredPairs: number }>(`${root}/benchmark-plan.json`);
    const result = json<{ sourceCommit: string; report: Parameters<typeof evaluateCacheBenchmarkTarget>[0];
      target: ReturnType<typeof evaluateCacheBenchmarkTarget>; productionLatencyQualification: boolean }>(`${root}/benchmark-report.json`);
    expect(result.sourceCommit).toBe(run.sourceCommit);
    expect(result.productionLatencyQualification).toBe(false);
    expect(result.report).toMatchObject({ warmupCalls: plan.warmupCalls, measuredCalls: plan.measuredPairs * 2,
      minimumBenefitTargetBps: plan.minimumBenefitTargetBps });
    expect(result.report.enabled).toMatchObject({ averageCostUsd: null, averageInputTokens: null, averageCachedInputTokens: null });
    expect(result.target).toEqual(evaluateCacheBenchmarkTarget(result.report));
    expect(['pass', 'fail']).toContain(result.target.outcome);
    const g5 = run.evidence.find(item => item.caseId === 'D30-CCP-G5')!;
    const artifact = json<{ outcome: string; details: { benchmarkTarget: unknown; tests: Array<{ status: string }> } }>(`${root}/${g5.artifact}`);
    expect(artifact.details.benchmarkTarget).toEqual(result.target);
    expect(g5.outcome).toBe(result.target.outcome === 'pass' && artifact.details.tests.every(test => test.status === 'passed') ? 'pass' : 'fail');
  });
});
