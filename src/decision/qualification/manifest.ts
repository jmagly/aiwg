import { createHash } from 'node:crypto';
import type { QualificationCase, QualificationRunManifest } from './types.js';

const ids = (prefix: 'C' | 'TV', count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);

export const REQUIRED_BASELINE_CASE_IDS = ids('C', 42);
export const REQUIRED_VENDOR_CASE_IDS = ids('TV', 25);

export function expectedQualificationCaseIds(): string[] {
  return [...REQUIRED_BASELINE_CASE_IDS, ...REQUIRED_VENDOR_CASE_IDS];
}

export function validateCaseInventory(cases: readonly QualificationCase[]): string[] {
  const actual = new Set<string>();
  const errors: string[] = [];
  for (const item of cases) {
    if (actual.has(item.id)) errors.push(`duplicate:${item.id}`);
    actual.add(item.id);
  }
  for (const id of expectedQualificationCaseIds()) {
    if (!actual.has(id)) errors.push(`missing:${id}`);
  }
  for (const id of actual) {
    if (!expectedQualificationCaseIds().includes(id)) errors.push(`unexpected:${id}`);
  }
  return errors.sort();
}

export function stableManifestDigest(manifest: QualificationRunManifest): `sha256:${string}` {
  const canonical = JSON.stringify({
    ...manifest,
    cases: [...manifest.cases].sort((a, b) => a.id.localeCompare(b.id)),
    evidence: [...manifest.evidence].sort((a, b) => a.caseId.localeCompare(b.caseId)),
    evidenceFlags: Object.fromEntries(Object.entries(manifest.evidenceFlags).sort(([a], [b]) => a.localeCompare(b))),
    ...(manifest.gateArtifacts ? { gateArtifacts: Object.fromEntries(Object.entries(manifest.gateArtifacts)
      .sort(([a], [b]) => a.localeCompare(b))) } : {}),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
