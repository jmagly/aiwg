import type {
  QualificationGateDefinition,
  QualificationGateResult,
  QualificationReport,
  QualificationRunManifest,
} from './types.js';
import { expectedQualificationCaseIds, validateCaseInventory } from './manifest.js';

// Negative evidence always overrides a positive suite result. A release reviewer
// cannot waive these conditions by supplying passing evidence checks.
const BLOCKING_FINDINGS: Readonly<Record<string, readonly string[]>> = {
  G1: ['p0-correctness-failed', 'execution-uncertain'],
  G2: ['privacy-denied'],
  G3: ['calibration-data-missing'],
  G6: ['p0-correctness-failed', 'execution-uncertain', 'privacy-denied', 'calibration-data-missing'],
};

export const DECISION_RELEASE_GATES: readonly QualificationGateDefinition[] = [
  { id: 'G0', title: 'contract and conformance', mandatory: true, requiredCaseIds: [], requiredEvidence: ['case-inventory-complete'] },
  { id: 'G1', title: 'runtime and adapter correctness', mandatory: true, requiredCaseIds: [], requiredEvidence: ['runtime-suite-complete'] },
  { id: 'G2', title: 'privacy and security', mandatory: true, requiredCaseIds: [], requiredEvidence: ['privacy-scan-clean', 'security-suite-complete'] },
  { id: 'G3', title: 'calibration and held-out quality', mandatory: true, requiredCaseIds: [], requiredEvidence: ['immutable-splits', 'calibration-qualified'] },
  { id: 'G4', title: 'operational resilience', mandatory: true, requiredCaseIds: [], requiredEvidence: ['fault-suite-complete', 'drift-suite-complete'] },
  { id: 'G5', title: 'performance and resource bounds', mandatory: true, requiredCaseIds: [], requiredEvidence: ['load-manifest-qualified'] },
  { id: 'G6', title: 'release evidence and review', mandatory: true, requiredCaseIds: [], requiredEvidence: ['evidence-hashes-verified', 'review-decision-recorded'] },
] as const;

function evaluateGate(definition: QualificationGateDefinition, manifest: QualificationRunManifest): QualificationGateResult {
  const evidenceByCase = new Map(manifest.evidence.map(item => [item.caseId, item]));
  const requiredCases = definition.id === 'G0'
    ? expectedQualificationCaseIds()
    : definition.requiredCaseIds;
  const missing: string[] = [];
  const failed: string[] = [];
  if (definition.id === 'G0') {
    missing.push(...validateCaseInventory(manifest.cases).map(error => `inventory:${error}`));
  }

  for (const caseId of requiredCases) {
    const evidence = evidenceByCase.get(caseId);
    if (!evidence || !evidence.executable || !evidence.artifact || !evidence.digest
      || !/^sha256:[a-f0-9]{64}$/.test(evidence.digest)) {
      missing.push(`case:${caseId}`);
    } else if (evidence.outcome !== 'pass') {
      failed.push(`case:${caseId}:${evidence.outcome}`);
    }
  }
  for (const key of definition.requiredEvidence) {
    if (manifest.evidenceFlags[key] !== true) missing.push(`evidence:${key}`);
  }
  for (const key of BLOCKING_FINDINGS[definition.id] ?? []) {
    if (manifest.evidenceFlags[key] === true) failed.push(`finding:${key}`);
  }

  // Mandatory gates never turn absent evidence into a skip/pass. Skip is reserved
  // for future explicitly optional gates.
  const status = missing.length || failed.length ? (definition.mandatory ? 'fail' : 'skip') : 'pass';
  return { id: definition.id, title: definition.title, status, missing: missing.sort(), failed: failed.sort() };
}

export function evaluateQualification(
  manifest: QualificationRunManifest,
  definitions: readonly QualificationGateDefinition[] = DECISION_RELEASE_GATES,
): QualificationReport {
  const gates = definitions.map(definition => evaluateGate(definition, manifest));
  const mandatoryFailed = gates.some((gate, index) => definitions[index]?.mandatory && gate.status !== 'pass');
  return {
    schemaVersion: 'decision-qualification-report/v1',
    runId: manifest.runId,
    generatedAt: manifest.generatedAt,
    decision: mandatoryFailed ? 'HOLD' : 'PROMOTE',
    gates,
  };
}
