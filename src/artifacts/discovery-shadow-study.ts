// D27 preregistration and explicitly unrun study reports; never performs inference.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { admitEntry } from '../decision/entry.js';
import type { ArtifactPin } from '../decision/types.js';
import { evaluateUpstreamCeiling, type QualificationIntegrityMetadata } from '../gates/upstream-ceiling.js';
import { ceilingDecision, type GateOutcome } from '../gates/lattice.js';
import { canonicalJson } from '../security/artifact-trust.js';

export const DISCOVERY_STUDY_SLICES = ['exact-name', 'high-margin', 'low-margin', 'cross-type', 'hard-negative', 'no-match'] as const;
export const DISCOVERY_STUDY_METRICS = ['hitAt1', 'hitAt3', 'mrr', 'ndcgAt10', 'hardNegativeIntrusion',
  'noMatchPrecision', 'noMatchRecall', 'selectiveCoverage', 'selectiveRisk', 'tieRate', 'p50LatencyMs', 'p95LatencyMs',
  'calls', 'inputTokens', 'outputTokens', 'costUsd', 'wrongLoads', 'extraShowCalls', 'exploratoryTokens', 'correctionTurns'] as const;
type Digest = `sha256:${string}`;
export interface DiscoveryStudyManifest {
  schemaVersion: 'decision-discovery-study-manifest/v1';
  id: string;
  state: 'draft' | 'registered';
  registeredAt: string | null;
  dataset: { id: string; digest: Digest; splitMethod: 'source' | 'time'; tuning: Digest; calibration: Digest; holdout: Digest };
  pins: { definition: ArtifactPin; binding: ArtifactPin; calibration: Digest; pricing: Digest; ambiguityPolicy: Digest; model: string };
  thresholds: {
    minimumTotal: number;
    minimumPerSlice: Record<typeof DISCOVERY_STUDY_SLICES[number], number>;
    powerRule: string | null;
    confidenceInterval: { method: 'paired-bootstrap'; level: number; seed: number; resamples: number };
    overallNonInferiorityMargin: number;
    ambiguityMetric: 'mrr';
    minimumAmbiguityImprovement: number;
    historicalBaseline: { hitAt3: 1; mrr: 0.9875 };
    positiveTotalEconomics: true;
    minimumTokenSavings: number;
    minimumCostSavingsUsd: number;
    maximumP95LatencyMs: number;
    maximumSelectiveRisk: number;
  };
  digest: Digest;
}
export type DiscoveryStudyMetricSlots = Record<typeof DISCOVERY_STUDY_METRICS[number], null>;
export interface DiscoveryStudyReport {
  schemaVersion: 'decision-discovery-study-report/v1';
  manifest: DiscoveryStudyManifest;
  runStatus: 'not-run';
  holdoutAccessedAt: null;
  integrity: QualificationIntegrityMetadata | null;
  upstreamDecision: GateOutcome;
  decision: GateOutcome;
  metrics: { baseline: DiscoveryStudyMetricSlots; alternate: DiscoveryStudyMetricSlots };
  slices: Array<{ id: typeof DISCOVERY_STUDY_SLICES[number]; sampleCount: 0;
    baseline: DiscoveryStudyMetricSlots; alternate: DiscoveryStudyMetricSlots }>;
  economics: { baseline: null; decisionCalls: null; fallback: null; downstream: null;
    totalTokenSavings: null; totalCostSavingsUsd: null; pricingDigest: Digest };
  confidenceIntervals: null;
  missingInputs: string[];
  digest: Digest;
}
export const discoveryStudyDigest = (value: unknown): Digest => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const validators = new Map<string, ValidateFunction>();
function checkSchema(name: 'Manifest' | 'Report', value: unknown): void {
  admitEntry(value);
  let validate = validators.get(name);
  if (!validate) {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = `DiscoveryStudy${name}.v1.schema.json`;
    const root = [resolve(here, '../../schemas/decision'), resolve(here, '../../../schemas/decision')]
      .find(candidate => existsSync(resolve(candidate, file)));
    if (!root) throw new Error('Discovery study schemas unavailable');
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    (addFormats as unknown as (instance: Ajv2020) => void)(ajv);
    // Each contract is self-contained so installed consumers need no tools/ imports.
    validate = ajv.compile(JSON.parse(readFileSync(resolve(root, file), 'utf8')));
    validators.set(name, validate);
  }
  if (!validate(value)) throw new Error(`Invalid discovery study ${name}: ${JSON.stringify(validate.errors)}`);
}
export function createDiscoveryStudyManifest(input: Omit<DiscoveryStudyManifest, 'schemaVersion' | 'digest'>): DiscoveryStudyManifest {
  const fields = { ...structuredClone(input), schemaVersion: 'decision-discovery-study-manifest/v1' as const };
  return validateDiscoveryStudyManifest({ ...fields, digest: discoveryStudyDigest(fields) });
}
export function validateDiscoveryStudyManifest(value: DiscoveryStudyManifest): DiscoveryStudyManifest {
  checkSchema('Manifest', value);
  const { digest, ...fields } = value;
  const t = value.thresholds;
  if (digest !== discoveryStudyDigest(fields) || (value.state === 'registered') !== (value.registeredAt !== null)
    || new Set([value.dataset.tuning, value.dataset.calibration, value.dataset.holdout]).size !== 3
    || Math.floor(t.confidenceInterval.resamples * (1 - t.confidenceInterval.level) / 2) < 5) {
    throw new Error('Invalid discovery study preregistration identity, split or CI support');
  }
  return value;
}
/** A separately anchored digest and access timestamp are required before reading any holdout.
 * This check validates ordering and identity, not operator approval or disjoint corpus membership. */
export function assertDiscoveryStudyRegistration(manifest: DiscoveryStudyManifest, trustedDigest: Digest, accessedAt: string): void {
  validateDiscoveryStudyManifest(manifest);
  if (manifest.state !== 'registered' || trustedDigest !== manifest.digest || !Number.isFinite(Date.parse(accessedAt))
    || Date.parse(manifest.registeredAt!) >= Date.parse(accessedAt)) throw new Error('Discovery study is not preregistered before holdout access');
}
const emptyMetrics = (): DiscoveryStudyMetricSlots => Object.fromEntries(DISCOVERY_STUDY_METRICS.map(key => [key, null])) as DiscoveryStudyMetricSlots;
export function buildUnrunDiscoveryStudyReport(manifest: DiscoveryStudyManifest, integrity: QualificationIntegrityMetadata | null = null): DiscoveryStudyReport {
  validateDiscoveryStudyManifest(manifest);
  const upstream = evaluateUpstreamCeiling(integrity);
  const fields: Omit<DiscoveryStudyReport, 'digest'> = {
    schemaVersion: 'decision-discovery-study-report/v1', manifest: structuredClone(manifest), runStatus: 'not-run', holdoutAccessedAt: null,
    integrity: structuredClone(integrity), upstreamDecision: integrity?.release_gate.decision ?? 'HOLD',
    decision: ceilingDecision(upstream.ceiling, 'HOLD'),
    metrics: { baseline: emptyMetrics(), alternate: emptyMetrics() },
    slices: DISCOVERY_STUDY_SLICES.map(id => ({ id, sampleCount: 0, baseline: emptyMetrics(), alternate: emptyMetrics() })),
    economics: { baseline: null, decisionCalls: null, fallback: null, downstream: null, totalTokenSavings: null,
      totalCostSavingsUsd: null, pricingDigest: manifest.pins.pricing }, confidenceIntervals: null,
    missingInputs: ['Live Jev run not done', 'Reviewed frozen holdout and independent labels not supplied',
      'Operator-approved calibration, pricing and paid-call authorization not supplied',
      'Paired quality confidence intervals and complete downstream economics not observed', ...upstream.problems],
  };
  return validateUnrunDiscoveryStudyReport({ ...fields, digest: discoveryStudyDigest(fields) });
}
export function validateUnrunDiscoveryStudyReport(value: DiscoveryStudyReport): DiscoveryStudyReport {
  checkSchema('Report', value);
  validateDiscoveryStudyManifest(value.manifest);
  const { digest, ...fields } = value;
  const ceiling = evaluateUpstreamCeiling(value.integrity);
  if (digest !== discoveryStudyDigest(fields) || value.upstreamDecision !== (value.integrity?.release_gate.decision ?? 'HOLD')
    || value.decision !== ceilingDecision(ceiling.ceiling, 'HOLD')
    || value.slices.map(slice => slice.id).join() !== DISCOVERY_STUDY_SLICES.join()
    || value.economics.pricingDigest !== value.manifest.pins.pricing) throw new Error('Discovery report changes its evidence or upgrades a gate');
  return value;
}
