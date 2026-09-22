import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  lintPatternMarkdown,
  runPatternOperationalGate,
  runPatternOperationalGateFromRoot,
} from '../../../tools/decision/pattern-operational-gate.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');

describe('PAT-OPS-001 installed operational gate', () => {
  it('executes containment, retained evidence, recovery, exit, and Markdown checks', () => {
    const report = runPatternOperationalGateFromRoot(ROOT);
    expect(report).toMatchObject({
      schema: 'decision-pattern-operational-gate-report/v1',
      manifest: 'JEV-22-G6',
      releaseGate: 'D11-G6',
      status: 'pass',
      markdown: { status: 'pass' },
    });
    expect(report.drills).toHaveLength(5);
    for (const drill of report.drills) {
      expect(drill).toMatchObject({ status: 'pass', sanitized: true });
      expect(drill.evidence.length).toBeGreaterThan(0);
      expect(drill.exitVerification.length).toBeGreaterThan(0);
    }
    expect(report.retainedTestEvidence).toContain('PAT-DURABLE-001');
    expect(report.retainedTestEvidence).toContain('PAT-OPS-001');
  });

  it('fails closed when containment or retained PAT evidence drifts', () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'docs/decision/operations/closure-manifest.v1.json'), 'utf8'));
    const runbookDocument = readFileSync(path.join(ROOT, manifest.runbookDocument), 'utf8');
    const markdownDocuments = [{ name: 'ok.md', source: '# OK\n' }];
    const containmentDrift = structuredClone(manifest);
    containmentDrift.drills[0].expectedContainment = 'fail-open';
    expect(() => runPatternOperationalGate({ manifest: containmentDrift, runbookDocument, markdownDocuments }))
      .toThrow('containment mismatch');
    const evidenceDrift = structuredClone(manifest);
    evidenceDrift.retention.testEvidence = evidenceDrift.retention.testEvidence.filter((id: string) => id !== 'PAT-DURABLE-001');
    expect(() => runPatternOperationalGate({ manifest: evidenceDrift, runbookDocument, markdownDocuments }))
      .toThrow('required PAT evidence is not retained');
  });

  it('fails Markdown lint on packaged documentation defects', () => {
    expect(lintPatternMarkdown('bad.md', '# Top\n### Skipped\t \n```\n')).toEqual(expect.arrayContaining([
      expect.stringContaining('MD009'),
      expect.stringContaining('MD010'),
      expect.stringContaining('MD001'),
      expect.stringContaining('MD040'),
    ]));
  });
});
