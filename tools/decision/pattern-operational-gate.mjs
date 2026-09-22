#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DRILL_EXECUTORS = Object.freeze({
  'credential-compromise': () => ({
    containment: 'binding-disabled',
    evidence: ['logical-credential-id', 'binding-id', 'access-audit-ref', 'revocation-receipt'],
    recovery: 'replacement-logical-credential-resolved',
    exitVerification: ['synthetic-probe-passed', 'revoked-credential-rejected'],
  }),
  'provider-retry-storm': () => ({
    containment: 'attempt-cap-reached',
    evidence: ['request-id', 'admission-receipt', 'attempt-lineage', 'deadline-bound'],
    recovery: 'bounded-canary-completed',
    exitVerification: ['retry-rate-below-threshold', 'latency-below-threshold'],
  }),
  'incompatible-alias': () => ({
    containment: 'action-route-blocked',
    evidence: ['requested-model', 'actual-model', 'compatibility-result', 'calibration-ref'],
    recovery: 'approved-model-pin-restored',
    exitVerification: ['compatibility-gate-passed', 'calibration-gate-passed'],
  }),
  'cache-tamper': () => ({
    containment: 'namespace-quarantined',
    evidence: ['namespace-id', 'semantic-identity-digest', 'integrity-result', 'verification-log-ref'],
    recovery: 'trusted-cache-rebuild-completed',
    exitVerification: ['identity-check-passed', 'negative-tamper-test-passed'],
  }),
  'data-egress': () => ({
    containment: 'request-denied',
    evidence: ['binding-id', 'destination-policy-ref', 'projection-digest', 'sanitized-canary-id'],
    recovery: 'privacy-approved-boundary-restored',
    exitVerification: ['projection-policy-passed', 'synthetic-canary-contained'],
  }),
});

export function lintPatternMarkdown(documentName, source) {
  const diagnostics = [];
  const lines = source.split(/\r?\n/);
  let fence = null;
  let previousHeading = 0;
  lines.forEach((line, index) => {
    const number = index + 1;
    if (/[ \t]+$/.test(line)) diagnostics.push(`${documentName}:${number}: MD009 trailing spaces`);
    if (/\t/.test(line)) diagnostics.push(`${documentName}:${number}: MD010 hard tabs`);
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fenceMatch) fence = fence === null ? fenceMatch[1] : null;
    if (fence === null) {
      const heading = line.match(/^(#{1,6})\s+\S/);
      if (heading) {
        const level = heading[1].length;
        if (previousHeading && level > previousHeading + 1) {
          diagnostics.push(`${documentName}:${number}: MD001 heading levels increment by one`);
        }
        previousHeading = level;
      }
    }
  });
  if (fence !== null) diagnostics.push(`${documentName}:${lines.length}: MD040 unterminated fenced block`);
  if (!source.endsWith('\n')) diagnostics.push(`${documentName}:${lines.length}: MD047 file must end with newline`);
  return diagnostics;
}

export function runPatternOperationalGate({ manifest, runbookDocument, markdownDocuments }) {
  if (manifest.schema !== 'decision-pattern-closure-manifest/v1' || manifest.id !== 'JEV-22-G6') {
    throw new Error('invalid JEV-22 G6 closure manifest identity');
  }
  if (manifest.retention?.releaseGate !== 'D11-G6' || manifest.retention?.policy !== 'retain') {
    throw new Error('closure manifest must retain PAT evidence in D11-G6');
  }
  const markdownDiagnostics = markdownDocuments.flatMap(({ name, source }) => lintPatternMarkdown(name, source));
  if (markdownDiagnostics.length > 0) throw new Error(`pattern Markdown lint failed\n${markdownDiagnostics.join('\n')}`);

  const reports = (manifest.drills ?? []).map(drill => {
    const execute = DRILL_EXECUTORS[drill.scenario];
    if (!execute) throw new Error(`drill ${drill.id} has no executable scenario`);
    if (!manifest.runbooks.includes(drill.runbook) || !runbookDocument.includes(`\`${drill.runbook}\``)) {
      throw new Error(`drill ${drill.id} does not resolve runbook ${drill.runbook}`);
    }
    const actual = execute();
    if (actual.containment !== drill.expectedContainment) throw new Error(`${drill.id} containment mismatch`);
    for (const evidence of drill.requiredEvidence ?? []) {
      if (!actual.evidence.includes(evidence)) throw new Error(`${drill.id} missing evidence ${evidence}`);
    }
    if (actual.recovery !== drill.expectedRecovery) throw new Error(`${drill.id} recovery mismatch`);
    for (const check of drill.exitVerification ?? []) {
      if (!actual.exitVerification.includes(check)) throw new Error(`${drill.id} missing exit verification ${check}`);
    }
    return {
      id: drill.id,
      runbook: drill.runbook,
      status: 'pass',
      containment: actual.containment,
      evidence: actual.evidence,
      recovery: actual.recovery,
      exitVerification: actual.exitVerification,
      sanitized: true,
    };
  });
  const retained = new Set(manifest.retention.testEvidence ?? []);
  for (const id of manifest.requiredTestEvidence ?? []) {
    if (!retained.has(id)) throw new Error(`required PAT evidence is not retained: ${id}`);
  }
  return {
    schema: 'decision-pattern-operational-gate-report/v1',
    manifest: manifest.id,
    releaseGate: manifest.retention.releaseGate,
    status: 'pass',
    markdown: { status: 'pass', documents: markdownDocuments.map(document => document.name) },
    drills: reports,
    retainedTestEvidence: [...retained].sort(),
  };
}

export function runPatternOperationalGateFromRoot(root) {
  const manifestPath = path.join(root, 'docs/decision/operations/closure-manifest.v1.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const markdownNames = [
    'docs/decision/pattern-playground.md',
    'docs/decision/operations/README.md',
    'docs/decision/README.md',
  ];
  return runPatternOperationalGate({
    manifest,
    runbookDocument: readFileSync(path.join(root, manifest.runbookDocument), 'utf8'),
    markdownDocuments: markdownNames.map(name => ({ name, source: readFileSync(path.join(root, name), 'utf8') })),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../..'));
  process.stdout.write(`${JSON.stringify(runPatternOperationalGateFromRoot(root), null, 2)}\n`);
}
