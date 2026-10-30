import { assertDecisionCeiling, ceilingDecision } from '../../gates/lattice.js';
import type { GateOutcome } from '../../gates/types.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { admitEntry, DEFAULT_ENTRY_LIMITS } from '../entry.js';
import { heldoutDigest } from '../heldout/contract.js';
import { D17_ANALYSIS, validateD17Analysis } from './protocol.js';
import type { prepareD17Study } from './corpus.js';

const schemas = { analysis: 'D17StudyAnalysis', splits: 'D17StudySplits', gold: 'D17StudyGold',
  review: 'D17StudyReview', guide: 'D17StudyGuide', report: 'D17StudyReport',
  nativeTemplates: 'D17StudyNativeTemplates', dryRun: 'D17StudyDryRun',
  // Staged D09 calibration (#2611): new schema versions; the v1 diagnostic schemas are unchanged.
  analysisV2: 'D17StudyAnalysis.v2', dryRunV2: 'D17StudyDryRun.v2', reportV2: 'D17StudyReport.v2',
  calibration: 'D17StudyCalibration' } as const;
type Prepared = ReturnType<typeof prepareD17Study>;
type Assessment = Omit<Prepared['reviewTemplate']['assessments'][number], 'reviewedAt' | 'goldAuditLabel'
  | 'goldAmbiguousOrIncorrect' | 'blindedResultAudit' | 'rationale'> & {
  reviewedAt: string | null; goldAuditLabel: 'yes' | 'no' | null; goldAmbiguousOrIncorrect: boolean | null;
  blindedResultAudit: string | null; rationale: string | null;
};
export type D17Review = Omit<Prepared['reviewTemplate'], 'reviewer' | 'preregistrationReview' | 'finalDispositionReview' | 'assessments'> & {
  reviewer: string | null; preregistrationReview: string | null; finalDispositionReview: string | null; assessments: Assessment[];
};
type Artifacts = { analysis: Prepared['analysis']; splits: Prepared['splitManifest']; gold: Prepared['gold'];
  review: D17Review; guide: Prepared['guide']; report: Record<string, unknown>;
  nativeTemplates: Prepared['nativeTemplates']; dryRun: Prepared['dryRun'];
  analysisV2: Record<string, unknown>; dryRunV2: Record<string, unknown>; reportV2: Record<string, unknown>;
  calibration: Record<string, unknown> };
const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = [resolve(here, '../../../schemas/decision'), resolve(here, '../../../../schemas/decision')]
  .find(directory => existsSync(resolve(directory, 'D17StudyProtocol.v1.schema.json')));
if (!schemaDir) throw new Error('D17 artifact schema directory is unavailable');
const readSchema = (name: string) => JSON.parse(readFileSync(resolve(schemaDir, `${/\.v[0-9]+$/.test(name) ? name : `${name}.v1`}.schema.json`), 'utf8'));
const ajv = new Ajv2020({ strict: true });
ajv.addSchema(readSchema('D17StudyProtocol'));
ajv.addSchema(readSchema('DecisionEnsembleAggregate'));
ajv.addSchema(readSchema('DecisionEnsembleIntegrityReport'));
const calibrationSchema = readSchema('D17StudyCalibration');
ajv.addSchema(calibrationSchema);
const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name,
  name === 'calibration' ? ajv.getSchema(calibrationSchema.$id)! : ajv.compile(readSchema(schema))]));
const limits = { ...DEFAULT_ENTRY_LIMITS, serializedBytes: 8_388_608, properties: 100000, entries: 150000,
  arrayLength: 1800, memoryBytes: 33_554_432 };
const reportLimits = { ...limits, serializedBytes: 33_554_432, properties: 500000, entries: 1000000, memoryBytes: 134_217_728 };

/** Closed, bounded preparation artifacts; gold remains local and separate from provider input. */
export function validateD17Artifact<K extends keyof Artifacts>(name: K, value: unknown): asserts value is Artifacts[K] {
  admitEntry(value, name === 'report' || name === 'reportV2' ? reportLimits : limits);
  if (!validators[name]?.(value)) throw new Error(`D17 invalid ${name} artifact`);
  if (name === 'analysis' || name === 'analysisV2') {
    validateD17Analysis((value as Artifacts['analysis']).protocol);
  }
  if (name === 'nativeTemplates') {
    validateD17Analysis({ ...D17_ANALYSIS, native: (value as Artifacts['nativeTemplates']).comparison.pairedMetrics });
  }
  if (name === 'report' || name === 'reportV2') {
    const report = value as { decision: GateOutcome; integrity: QualificationIntegrityMetadata };
    assertDecisionCeiling(report.decision, ceilingDecision('HOLD', report.integrity.release_gate.decision,
      report.integrity.compromise_labels.length ? 'ROLLBACK' : 'PROMOTE'));
  }
  if (name === 'splits') {
    const manifest = value as Artifacts['splits'];
    const ids = new Set<string>(), inputs = new Set<string>(), families = new Map<string, string>();
    for (const [split, group] of Object.entries(manifest.splits)) {
      if (heldoutDigest(group.members) !== group.digest) throw new Error('D17 split digest mismatch');
      for (const row of group.members) {
        if (ids.has(row.id) || inputs.has(row.inputDigest) || !/^[0-9a-f]{64}$/.test(row.id)
          || families.has(row.familyId) && families.get(row.familyId) !== split) throw new Error('D17 split isolation');
        ids.add(row.id); inputs.add(row.inputDigest); families.set(row.familyId, split);
      }
      for (const slice of ['direct-facts', 'multi-fact', 'negation', 'authority']) {
        if (group.members.filter(row => row.slice === slice).length !== group.count / 4) throw new Error('D17 slice quota');
      }
    }
  }
  if (name === 'gold') {
    const gold = value as Artifacts['gold'];
    if (Object.keys(gold.labels).some(id => !Object.hasOwn(gold.worlds, id))) throw new Error('D17 gold membership');
    if (Object.keys(gold.worlds).some(id => !Object.hasOwn(gold.labels, id))) throw new Error('D17 gold membership');
  }
  if (name === 'review') {
    const review = value as Artifacts['review'];
    if (new Set(review.assessments.map(row => row.assessmentId)).size !== 88) throw new Error('D17 review IDs');
    for (const [stage, count] of [['development', 40], ['blind-test', 40], ['delayed-repeat', 8]] as const) {
      const rows = review.assessments.filter(row => row.stage === stage);
      const framing = stage === 'development' ? 'A fictional archive records this world.'
        : 'The following is an imaginary station log.';
      if (rows.length !== count || new Set(rows.map(row => row.rowId)).size !== count
        || rows.some(row => !/^[0-9a-f]{64}$/.test(row.rowId) || typeof row.payload !== 'string' || !row.payload.startsWith(framing)
          || heldoutDigest({ payload: row.payload }) !== row.inputDigest)) {
        throw new Error('D17 review sample');
      }
      for (const slice of ['direct-facts', 'multi-fact', 'negation', 'authority']) {
        if (rows.filter(row => row.slice === slice).length !== count / 4) throw new Error('D17 review slice quota');
      }
    }
    const testIds = new Set(review.assessments.filter(row => row.stage === 'blind-test').map(row => row.rowId));
    if (review.assessments.some(row => row.stage === 'delayed-repeat' && !testIds.has(row.rowId))) throw new Error('D17 review repeat');
  }
}
