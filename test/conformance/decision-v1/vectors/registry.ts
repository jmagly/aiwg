import type { QualificationCaseExecutor } from '../../../../src/decision/index.js';
import * as acceptance from './acceptance.js';
import * as batch from './batch.js';
import * as boundary from './boundary.js';
import * as calibration from './calibration.js';
import { CONTRACT_EVIDENCE_IDS, runContractChecks } from './contract.js';
import * as core from './core.js';
import * as operational from './operational.js';
import * as rule from './rule.js';
import * as runtime from './runtime.js';
import * as security from './security.js';
import * as state from './state.js';
import * as vendor from './vendor.js';

const CONFORMANCE = 'test/conformance/decision-v1';
const VECTORS = `${CONFORMANCE}/vectors`;

/** One executable vector module and the suite file that runs it on its own. */
export interface RegisteredVectorSuite {
  suite: string;
  module: string;
  executors: Readonly<Record<string, QualificationCaseExecutor>>;
  /** Checked-in inputs the vectors read; bound by digest into the evidence manifest. */
  sources: readonly string[];
  evidenceIds?: () => Promise<Readonly<Record<string, readonly string[]>>>;
}

const EXAMPLES = ['agentic/code/addons/decision-engine/examples/ruleset.json', 'agentic/code/addons/decision-engine/examples/binding-jev.json', 'agentic/code/addons/decision-engine/examples/input.json'];

/** Runs named suite checks after a case executor passes; either failing fails the case. */
function withNamedChecks(executor: QualificationCaseExecutor, checks: () => Promise<void>): QualificationCaseExecutor {
  return async context => {
    const result = await executor(context);
    if (result.outcome !== 'pass') return result;
    await checks();
    return result;
  };
}

export const QUALIFICATION_VECTOR_SUITES: readonly RegisteredVectorSuite[] = [
  { suite: `${CONFORMANCE}/core-vectors.test.ts`, module: `${VECTORS}/core.ts`, executors: core.executors, sources: EXAMPLES },
  { suite: `${CONFORMANCE}/acceptance-evidence.test.ts`, module: `${VECTORS}/acceptance.ts`, executors: acceptance.executors,
    sources: [...Object.values(acceptance.GOLDENS), ...EXAMPLES] },
  { suite: `${CONFORMANCE}/runtime-vectors.test.ts`, module: `${VECTORS}/runtime.ts`, executors: runtime.executors,
    sources: [...EXAMPLES, 'agentic/code/addons/decision-engine/examples/binding-fallback.json'] },
  { suite: `${CONFORMANCE}/rule-vectors.test.ts`, module: `${VECTORS}/rule.ts`, executors: rule.executors, sources: EXAMPLES },
  { suite: `${CONFORMANCE}/state-vectors.test.ts`, module: `${VECTORS}/state.ts`, executors: state.executors, sources: EXAMPLES },
  // C36 (contract validation) also carries the CON-* contract-conformance suite for G0.
  { suite: `${CONFORMANCE}/security-vectors.test.ts`, module: `${VECTORS}/security.ts`,
    executors: { ...security.executors, C36: withNamedChecks(security.executors.C36, runContractChecks) },
    sources: [...EXAMPLES, `${VECTORS}/contract.ts`], evidenceIds: async () => ({ C36: [...CONTRACT_EVIDENCE_IDS] }) },
  { suite: `${CONFORMANCE}/operational-vectors.test.ts`, module: `${VECTORS}/operational.ts`, executors: operational.executors,
    sources: EXAMPLES },
  { suite: `${CONFORMANCE}/boundary-vectors.test.ts`, module: `${VECTORS}/boundary.ts`, executors: boundary.executors,
    sources: [...EXAMPLES, 'agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/decision-evaluate.mjs'] },
  { suite: `${CONFORMANCE}/batch-evidence.test.ts`, module: `${VECTORS}/batch.ts`, executors: batch.executors, sources: EXAMPLES },
  { suite: 'test/unit/decision/calibration-qualification-evidence.test.ts', module: `${VECTORS}/calibration.ts`,
    executors: calibration.executors, sources: [calibration.CROSS_PRODUCT_FIXTURE, 'docs/decision/evidence/calibration-rollout-v1.json'],
    evidenceIds: async () => ({ TV10: await calibration.calibrationEvidenceIds() }) },
  { suite: `${CONFORMANCE}/vendor-vectors.test.ts`, module: `${VECTORS}/vendor.ts`, executors: vendor.executors,
    sources: [vendor.VENDOR_CATALOG, ...EXAMPLES], evidenceIds: async () => vendor.EVIDENCE_IDS as Record<string, readonly string[]> },
];

export interface QualificationRegistry {
  executors: Record<string, QualificationCaseExecutor>;
  suiteByCase: Record<string, RegisteredVectorSuite>;
  evidenceIds: Record<string, readonly string[]>;
}

/** Merges every vector module; a case registered twice is a registry error. */
export async function loadQualificationRegistry(): Promise<QualificationRegistry> {
  const registry: QualificationRegistry = { executors: {}, suiteByCase: {}, evidenceIds: {} };
  for (const suite of QUALIFICATION_VECTOR_SUITES) {
    for (const [caseId, executor] of Object.entries(suite.executors)) {
      if (registry.executors[caseId]) throw new Error(`qualification case registered twice: ${caseId}`);
      registry.executors[caseId] = executor;
      registry.suiteByCase[caseId] = suite;
    }
    Object.assign(registry.evidenceIds, await suite.evidenceIds?.());
  }
  return registry;
}
